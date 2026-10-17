import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelsJsonProvider } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";
import { configObject } from "./document.ts";
import type { ModelsConfig } from "./schema.ts";
import { createRuntimeStreams } from "./streams.ts";

/** 只注册请求增强，认证与完整模型定义由外层 ModelRuntime 组合。 */
export function registerOpenAICompatibleProviders(pi: ExtensionAPI, config: ModelsConfig): void {
	for (const [id, provider] of Object.entries(config.providers)) {
		pi.registerProvider(createProvider({
			id,
			name: provider.name ?? id,
			baseUrl: provider.baseUrl,
			auth: { apiKey: envApiKeyAuth(`${provider.name ?? id} API key`, []) },
			// SDK 根据底层目录选择 API 包装，保留显式模型的 ID/API。
			models: (provider.models ?? []).map((model) => ({
				id: model.id, name: model.id, api: model.api ?? provider.api,
				provider: id, baseUrl: provider.baseUrl, reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000, maxTokens: 16_384,
			})),
			api: createRuntimeStreams(provider),
		}));
	}
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || (model.api !== "openai-completions" && model.api !== "openai-responses")) return;
		// 配置已通过 SDK schema 校验，不能用合成后的 model.maxTokens 判断是否显式配置。
		const provider = config.source.providers[model.provider] as ModelsJsonProvider | undefined;
		if (!provider) return;
		const maxTokens = provider.modelOverrides?.[model.id]?.maxTokens
			?? provider.models?.find((entry) => entry.id === model.id)?.maxTokens;
		if (maxTokens !== undefined || !configObject(event.payload)) return;
		const payload = { ...event.payload };
		delete payload.max_tokens;
		delete payload.max_completion_tokens;
		delete payload.max_output_tokens;
		return payload;
	});
	pi.on("model_select", (event) => {
		if (event.source === "restore") return;
		const level = config.defaultThinkingLevels[event.model.provider]?.[event.model.id];
		if (level !== undefined) pi.setThinkingLevel(level);
	});
}
