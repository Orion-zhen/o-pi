import {
	clampThinkingLevel,
	type Api,
	type Model,
	type ModelThinkingLevel,
	type ProviderHeaders,
	type ProviderStreams,
	type StreamOptions,
} from "@earendil-works/pi-ai";
// coding-agent 的扩展加载器通过 compat 入口共享内置 API registry。
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";

import { resolveProviderRequestHeaders } from "./auth.ts";
import { resolveHeadersOrThrow } from "./config-values.ts";
import type { ModelOverrides } from "./models.ts";
import { isModelThinkingLevel, type ProviderConfig } from "./schema.ts";
import { applyModelSuffixPayload, applyResponsesThinkingPreset } from "./thinking-presets.ts";

/** 提供方配置只绑定一次，原生模型信息在请求时读取。 */
export function createRuntimeStreams(
	provider: ProviderConfig,
	modelOverrides: ReadonlyMap<string, ModelOverrides>,
): ProviderStreams {
	const completions = openAICompletionsApi();
	const responses = openAIResponsesApi();
	const apiFor = (model: Model<Api>) => model.api === "openai-responses" ? responses : completions;

	function requestOptions(model: Model<Api>, options: StreamOptions | undefined, level: ModelThinkingLevel): StreamOptions {
		const overrides = modelOverrides.get(model.id);
		const configuredHeaders = resolveHeadersOrThrow(overrides?.headers, `model "${model.provider}/${model.id}"`, options?.env);
		const headers = mergeHeaders(resolveProviderRequestHeaders(model.provider, options?.env), configuredHeaders, options?.headers);
		const preset = overrides?.thinkingPreset ?? provider.thinkingPreset ?? "none";
		return {
			...options,
			headers,
			...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
			...(provider.maxRetries !== undefined ? { maxRetries: provider.maxRetries } : {}),
			onPayload: async (payload, currentModel) => {
				if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
					throw new TypeError("OpenAI-compatible payload must be an object");
				}
				const patched: Record<string, unknown> = { ...payload };
				applyResponsesThinkingPreset(patched, currentModel, preset, level);
				Object.assign(patched, provider.extraBody);
				for (const key of provider.dropParams ?? []) delete patched[key];
				for (const key of overrides?.dropParams ?? []) delete patched[key];
				if (preset === "model-suffix") applyModelSuffixPayload(patched, currentModel, level);
				const transformed = await options?.onPayload?.(patched, currentModel);
				return transformed === undefined ? patched : transformed;
			},
		};
	}

	return {
		stream(model, context, options) {
			const effort = options && "reasoningEffort" in options ? options.reasoningEffort : undefined;
			const level = resolveThinkingLevel(effort, "reasoningEffort");
			return apiFor(model).stream(model, context, requestOptions(model, options, level));
		},
		streamSimple(model, context, options) {
			const level = clampThinkingLevel(model, resolveThinkingLevel(options?.reasoning, "reasoning"));
			return apiFor(model).streamSimple(model, context, requestOptions(model, options, level));
		},
	};
}

function mergeHeaders(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const headers: ProviderHeaders = {};
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) headers[name.toLowerCase()] = value;
	}
	return headers;
}

function resolveThinkingLevel(value: unknown, field: string): ModelThinkingLevel {
	if (value === undefined) return "off";
	if (!isModelThinkingLevel(value)) throw new TypeError(`OpenAI-compatible ${field} is invalid`);
	return value;
}
