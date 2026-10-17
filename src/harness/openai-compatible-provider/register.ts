import { createProvider, envApiKeyAuth, type RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchProviderModelsFromEndpoint } from "./models-endpoint.ts";
import { buildModels } from "./models.ts";
import type { ModelsConfig } from "./schema.ts";
import { createRuntimeStreams } from "./streams.ts";

/** 只注册增强型 provider，认证与原生配置由外层 ModelRuntime 组合。 */
export function registerOpenAICompatibleProviders(pi: ExtensionAPI, config: ModelsConfig, configPath: string): void {
	const providers = Object.entries(config.providers).map(([id, provider]) => {
		return createProvider({
			id,
			name: provider.name ?? id,
			baseUrl: provider.baseUrl,
			auth: { apiKey: envApiKeyAuth(`${provider.name ?? id} API key`, []) },
			// SDK 根据底层目录选择 API 包装，不能省略静态模型的 ID/API。
			models: buildModels(id, provider, (provider.models ?? []).map(({ id, api }) => ({ id, api: api ?? provider.api })), configPath),
			api: createRuntimeStreams(provider),
			...(provider.discoverModels ? {
				fetchModels: async (context: RefreshModelsContext) => {
					if (context.credential?.type !== "api_key") throw new TypeError(`Provider "${id}" discovery requires an API key credential`);
					const discovered = await fetchProviderModelsFromEndpoint(id, provider, configPath, context.credential, context.signal, context.baseUrl);
					return buildModels(id, provider, discovered, configPath);
				},
			} : {}),
		});
	});
	for (const provider of providers) pi.registerProvider(provider);
	pi.on("model_select", (event) => {
		if (event.source === "restore") return;
		const level = config.defaultThinkingLevels[event.model.provider]?.[event.model.id];
		if (level !== undefined) pi.setThinkingLevel(level);
	});
}
