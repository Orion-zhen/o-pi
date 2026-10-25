import type { ProviderStreams } from "@earendil-works/pi-ai";
// 与 coding-agent 的扩展加载器共享内置 API registry。
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { modelOptions, type ProviderConfig, type OpenAIApiName } from "./schema.ts";

/** 仅包装会话使用的 streamSimple，API 分派和认证由 SDK 负责。 */
export function createRuntimeStreams(config: ProviderConfig): Record<OpenAIApiName, ProviderStreams> {
	function wrap(api: ProviderStreams): ProviderStreams {
		return {
			...api,
			streamSimple(model, context, options) {
				const overrides = modelOptions(config, model.id);
				return api.streamSimple(model, context, {
					...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
					...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
					...options,
					onPayload: async (payload, currentModel) => {
						// 两种 SDK API 均在调用 onPayload 前构造请求对象。
						const patched = { ...(payload as Record<string, unknown>) };
						Object.assign(patched, config.extraBody);
						for (const key of config.dropParams ?? []) delete patched[key];
						for (const key of overrides.dropParams ?? []) delete patched[key];
						const transformed = await options?.onPayload?.(patched, currentModel);
						return transformed === undefined ? patched : transformed;
					},
				});
			},
		};
	}
	return { "openai-completions": wrap(openAICompletionsApi()), "openai-responses": wrap(openAIResponsesApi()) };
}
