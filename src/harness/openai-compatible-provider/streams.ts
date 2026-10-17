import { clampThinkingLevel, type ProviderStreams } from "@earendil-works/pi-ai";
// 与 coding-agent 的扩展加载器共享内置 API registry。
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { modelOptions, thinkingPresetIssue, type ProviderConfig, type OpenAIApiName } from "./schema.ts";
import { applyModelSuffixPayload, applyResponsesThinkingPreset, completionsThinkingCompat, stripThinkingPayload } from "./thinking-presets.ts";

/** 仅包装会话使用的 streamSimple，API 分派和认证由 SDK 负责。 */
export function createRuntimeStreams(config: ProviderConfig): Record<OpenAIApiName, ProviderStreams> {
	function wrap(api: ProviderStreams): ProviderStreams {
		return {
			...api,
			streamSimple(model, context, options) {
				const level = clampThinkingLevel(model, options?.reasoning ?? "off");
				const overrides = modelOptions(config, model.id);
				const preset = overrides.thinkingPreset ?? config.thinkingPreset;
				const issue = thinkingPresetIssue(model.api, preset);
				if (issue) throw new Error(issue);
				const requestModel = model.api === "openai-completions"
					? { ...model, compat: { ...model.compat, ...completionsThinkingCompat(preset) } } : model;
				return api.streamSimple(requestModel, context, {
					...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
					...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
					...options,
					onPayload: async (payload, currentModel) => {
						if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
							throw new TypeError("OpenAI-compatible payload must be an object");
						}
						const patched: Record<string, unknown> = { ...payload };
						applyResponsesThinkingPreset(patched, currentModel, preset, level);
						Object.assign(patched, config.extraBody);
						for (const key of config.dropParams ?? []) delete patched[key];
						for (const key of overrides.dropParams ?? []) delete patched[key];
						if (preset === "model-suffix") applyModelSuffixPayload(patched, currentModel, level);
						else if (preset === "none") stripThinkingPayload(patched);
						const transformed = await options?.onPayload?.(patched, currentModel);
						return transformed === undefined ? patched : transformed;
					},
				});
			},
		};
	}
	return { "openai-completions": wrap(openAICompletionsApi()), "openai-responses": wrap(openAIResponsesApi()) };
}
