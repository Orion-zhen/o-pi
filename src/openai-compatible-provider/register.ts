import {
	clampThinkingLevel,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyRuntimePayloadConfig, type NormalizedProvider, type RuntimeModelConfig } from "./normalize.js";

const runtimeModels = new Map<string, RuntimeModelConfig>();
const installedHooks = new WeakSet<ExtensionAPI>();
const completionsApi = openAICompletionsApi();
const responsesApi = openAIResponsesApi();

/** 注册所有归一化 provider，并安装按模型生效的 OpenAI payload 注入代理。 */
export function registerOpenAICompatibleProviders(pi: ExtensionAPI, providers: NormalizedProvider[]): void {
	for (const provider of providers) {
		for (const key of runtimeModels.keys()) {
			if (key.startsWith(`${provider.id}\u0000`)) runtimeModels.delete(key);
		}
		for (const [modelId, runtime] of provider.runtimeModels) {
			runtimeModels.set(runtimeKey(provider.id, modelId), runtime);
		}
		pi.registerProvider(provider.id, {
			...provider.config,
			streamSimple: provider.config.api === "openai-responses" ? responsesStreamSimple : completionsStreamSimple,
		});
	}
	if (installedHooks.has(pi)) return;
	installedHooks.add(pi);
	pi.on("model_select", (event) => {
		if (event.source !== "restore") applyConfiguredThinkingLevel(pi, event.model);
	});
}

/** 测试和诊断使用：读取已登记的请求期模型配置。 */
export function getRuntimeModelConfig(providerId: string, modelId: string): RuntimeModelConfig | undefined {
	return runtimeModels.get(runtimeKey(providerId, modelId));
}

function completionsStreamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	return completionsApi.streamSimple(model, context, withRuntimeOptions(model, options));
}

function responsesStreamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	return responsesApi.streamSimple(model, context, withRuntimeOptions(model, options));
}

function withRuntimeOptions(model: Model<Api>, options: SimpleStreamOptions | undefined): SimpleStreamOptions | undefined {
	const runtime = runtimeModels.get(runtimeKey(model.provider, model.id));
	if (!runtime) return options;
	const thinkingLevel = clampThinkingLevel(model, options?.reasoning ?? "off");
	return {
		...options,
		...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
		...(runtime.maxRetries !== undefined ? { maxRetries: runtime.maxRetries } : {}),
		onPayload: async (payload, payloadModel) => {
			const patched = applyRuntimePayloadConfig(payload, runtime, thinkingLevel);
			return options?.onPayload ? options.onPayload(patched, payloadModel) : patched;
		},
	};
}

function applyConfiguredThinkingLevel(pi: ExtensionAPI, model: Model<Api> | undefined): void {
	if (!model) return;
	const runtime = runtimeModels.get(runtimeKey(model.provider, model.id));
	if (runtime?.defaultThinkingLevel !== undefined) {
		pi.setThinkingLevel(runtime.defaultThinkingLevel);
	}
}

function runtimeKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}
