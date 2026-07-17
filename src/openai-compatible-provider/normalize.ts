import {
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { ProviderConfig as PiProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { invalidModelsJsonc } from "./errors.js";
import { defaultApiKeyConfig } from "./provider-defaults.js";
import { allowsNonStandardSampling, resolveCompat } from "./presets.js";
import type { CompatPresetName, ModelsJsoncConfig, SamplingDefaults, ThinkingPresetName } from "./schema.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CORE_PAYLOAD_FIELDS = new Set(["model", "messages", "input", "tools", "stream"]);
const THINKING_PAYLOAD_FIELDS = ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"] as const;
const THINKING_LEVEL_VALIDATION_MODEL: Model<"openai-completions"> = {
	id: "thinking-level-validation",
	name: "thinking-level-validation",
	api: "openai-completions",
	provider: "thinking-level-validation",
	baseUrl: "http://127.0.0.1/v1",
	reasoning: true,
	input: ["text"],
	cost: ZERO_COST,
	contextWindow: 1,
	maxTokens: 1,
};

/** 单个模型的请求期附加配置；Pi 模型类型不允许扩展字段，因此保存在内部映射。 */
export interface RuntimeModelConfig {
	api: "openai-completions" | "openai-responses";
	compatPreset: CompatPresetName;
	thinkingPreset: ThinkingPresetName;
	reasoning: boolean;
	defaultThinkingLevel?: ModelThinkingLevel;
	thinkingLevelMap?: ThinkingLevelMap;
	defaults?: SamplingDefaults;
	dropParams: string[];
	extraBody: Record<string, unknown>;
	timeoutMs?: number;
	maxRetries?: number;
	compat: NonNullable<ProviderModelConfig["compat"]>;
}

/** 归一化后的 provider，包含 Pi 注册配置和请求期内部配置。 */
export interface NormalizedProvider {
	id: string;
	config: PiProviderConfig;
	runtimeModels: Map<string, RuntimeModelConfig>;
}

/** 将用户友好的 JSONC 配置转换成 pi.registerProvider 可消费的结构。 */
export function normalizeModelsJsoncConfig(config: ModelsJsoncConfig, configPath: string): NormalizedProvider[] {
	return Object.entries(config.providers).map(([providerId, provider]) => {
		if (!Array.isArray(provider.models)) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" models must be resolved before registration`);
		}

		const api = provider.api === "responses" ? "openai-responses" : "openai-completions";
		const compatPreset = provider.compat ?? "openai_compatible";
		const thinkingPreset = provider.thinking ?? "none";
		const providerExtraBody = provider.advanced?.extra_body ?? {};
		assertNoCorePayloadFields(providerExtraBody, configPath, `providers.${providerId}.advanced.extra_body`);

		const seenModels = new Set<string>();
		const runtimeModels = new Map<string, RuntimeModelConfig>();
		const models: ProviderModelConfig[] = provider.models.map((entry, index) => {
			const model = typeof entry === "string" ? { model: entry } : entry;
			if (seenModels.has(model.model)) {
				throw invalidModelsJsonc(configPath, `provider "${providerId}" contains duplicate model "${model.model}"`);
			}
			seenModels.add(model.model);

			const modelExtraBody = model.advanced?.extra_body ?? {};
			assertNoCorePayloadFields(modelExtraBody, configPath, `providers.${providerId}.models[${index}].advanced.extra_body`);
			const compat = resolveCompat(compatPreset, thinkingPreset, model.advanced?.compat);
			const dropParams = [...(provider.advanced?.drop_params ?? []), ...(model.advanced?.drop_params ?? [])];
			const extraBody = { ...providerExtraBody, ...modelExtraBody };
			const reasoning = model.thinking_level !== undefined || model.thinking_level_map !== undefined;
			assertValidThinkingConfig(model.thinking_level, model.thinking_level_map, configPath, `providers.${providerId}.models[${index}]`);
			runtimeModels.set(model.model, {
				api,
				compatPreset,
				thinkingPreset,
				reasoning,
				...(model.thinking_level !== undefined ? { defaultThinkingLevel: model.thinking_level } : {}),
				...(model.thinking_level_map !== undefined ? { thinkingLevelMap: model.thinking_level_map } : {}),
				...(model.defaults !== undefined ? { defaults: model.defaults } : {}),
				dropParams,
				extraBody,
				...(provider.advanced?.timeout_ms !== undefined ? { timeoutMs: provider.advanced.timeout_ms } : {}),
				...(provider.advanced?.max_retries !== undefined ? { maxRetries: provider.advanced.max_retries } : {}),
				compat,
			});

			return {
				id: model.model,
				name: model.display_name ?? model.model,
				api,
				reasoning,
				...(model.thinking_level_map !== undefined ? { thinkingLevelMap: model.thinking_level_map } : {}),
				input: model.input ?? ["text"],
				cost: { ...ZERO_COST },
				contextWindow: model.context_window ?? DEFAULT_CONTEXT_WINDOW,
				maxTokens: model.max_tokens ?? DEFAULT_MAX_TOKENS,
				compat,
			};
		});

		return {
			id: providerId,
			runtimeModels,
			config: {
				name: provider.display_name ?? providerId,
				baseUrl: provider.base_url,
				apiKey: provider.api_key ? provider.api_key : defaultApiKeyConfig(providerId),
				api,
				...(provider.advanced?.headers !== undefined ? { headers: provider.advanced.headers } : {}),
				models,
			},
		};
	});
}

/** 将模型级 defaults 和 advanced payload 设置注入 OpenAI-compatible 请求体。 */
export function applyRuntimePayloadConfig(
	payload: unknown,
	runtime: RuntimeModelConfig,
	thinkingLevel: ModelThinkingLevel = "off",
): unknown {
	if (!isRecord(payload)) return payload;
	const next = { ...payload };
	for (const [key, value] of Object.entries(samplingDefaultsToPayload(runtime))) {
		if (value !== undefined) next[key] = value;
	}
	applyResponsesThinkingPreset(next, runtime, thinkingLevel);
	for (const [key, value] of Object.entries(runtime.extraBody)) {
		next[key] = value;
	}
	for (const key of runtime.dropParams) {
		delete next[key];
	}
	for (const key of CORE_PAYLOAD_FIELDS) {
		if (key in payload) next[key] = payload[key];
	}
	return next;
}

function samplingDefaultsToPayload(runtime: RuntimeModelConfig): Record<string, unknown> {
	const defaults = runtime.defaults;
	if (!defaults) return {};
	const payload: Record<string, unknown> = {};
	copyIfDefined(payload, "temperature", defaults.temperature);
	copyIfDefined(payload, "top_p", defaults.top_p);
	copyIfDefined(payload, "presence_penalty", defaults.presence_penalty);
	copyIfDefined(payload, "frequency_penalty", defaults.frequency_penalty);
	copyIfDefined(payload, "seed", defaults.seed);
	copyIfDefined(payload, "stop", defaults.stop);
	if (allowsNonStandardSampling(runtime.compatPreset)) {
		copyIfDefined(payload, "top_k", defaults.top_k);
		copyIfDefined(payload, "min_p", defaults.min_p);
		copyIfDefined(payload, "repetition_penalty", defaults.repetition_penalty);
	}
	if (defaults.max_tokens !== undefined) {
		payload[maxTokensField(runtime)] = defaults.max_tokens;
	}
	return payload;
}

function applyResponsesThinkingPreset(
	payload: Record<string, unknown>,
	runtime: RuntimeModelConfig,
	thinkingLevel: ModelThinkingLevel,
): void {
	if (runtime.api !== "openai-responses" || !runtime.reasoning || runtime.thinkingPreset === "openai") return;
	stripThinkingPayload(payload);
	if (runtime.thinkingPreset === "none") return;

	const enabled = thinkingLevel !== "off";
	const effort = mappedThinkingEffort(runtime.thinkingLevelMap, thinkingLevel);
	const offSupported = runtime.thinkingLevelMap?.off !== null;
	switch (runtime.thinkingPreset) {
		case "openrouter":
			if (effort !== undefined) payload.reasoning = { effort };
			return;
		case "deepseek":
			if (enabled) payload.thinking = { type: "enabled" };
			else if (offSupported) payload.thinking = { type: "disabled" };
			if (enabled && effort !== undefined && supportsReasoningEffort(runtime.compat)) payload.reasoning_effort = effort;
			return;
		case "together":
			payload.reasoning = { enabled };
			if (enabled && effort !== undefined && supportsReasoningEffort(runtime.compat)) payload.reasoning_effort = effort;
			return;
		case "zai":
			payload.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
			if (enabled && effort !== undefined && supportsReasoningEffort(runtime.compat)) payload.reasoning_effort = effort;
			return;
		case "qwen":
			payload.enable_thinking = enabled;
			return;
		case "qwen_chat_template":
			payload.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
			return;
		case "chat_template_enabled":
			payload.chat_template_kwargs = { enable_thinking: enabled };
			return;
		case "chat_template_effort":
			if (effort !== undefined) payload.chat_template_kwargs = { reasoning_effort: effort };
			return;
		case "string_thinking":
			if (effort !== undefined) payload.thinking = effort;
			return;
		case "ant_ling": {
			const mapped = enabled ? runtime.thinkingLevelMap?.[thinkingLevel] : undefined;
			if (typeof mapped === "string") payload.reasoning = { effort: mapped };
			return;
		}
	}
}

function mappedThinkingEffort(map: ThinkingLevelMap | undefined, level: ModelThinkingLevel): string | undefined {
	const mapped = map?.[level];
	if (mapped === null) return undefined;
	if (mapped !== undefined) return mapped;
	return level === "off" ? "none" : level;
}

function stripThinkingPayload(payload: Record<string, unknown>): void {
	for (const field of THINKING_PAYLOAD_FIELDS) delete payload[field];
	if (!Array.isArray(payload.include)) return;
	const include = payload.include.filter((value) => value !== "reasoning.encrypted_content");
	if (include.length > 0) payload.include = include;
	else delete payload.include;
}

function supportsReasoningEffort(compat: NonNullable<ProviderModelConfig["compat"]>): boolean {
	return "supportsReasoningEffort" in compat && compat.supportsReasoningEffort === true;
}

function maxTokensField(runtime: RuntimeModelConfig): string {
	if (runtime.api === "openai-responses") return "max_output_tokens";
	const value = hasMaxTokensField(runtime.compat) ? runtime.compat.maxTokensField : undefined;
	if (value === "max_tokens" || value === "max_completion_tokens") return value;
	return "max_completion_tokens";
}

function hasMaxTokensField(value: NonNullable<ProviderModelConfig["compat"]>): value is NonNullable<ProviderModelConfig["compat"]> & {
	maxTokensField?: "max_tokens" | "max_completion_tokens";
} {
	return "maxTokensField" in value;
}

function copyIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value;
}

function assertNoCorePayloadFields(value: Record<string, unknown>, configPath: string, fieldPath: string): void {
	for (const key of Object.keys(value)) {
		if (CORE_PAYLOAD_FIELDS.has(key)) {
			throw invalidModelsJsonc(configPath, `${fieldPath}.${key} cannot override core request field "${key}"`);
		}
	}
}

function assertValidThinkingConfig(
	defaultLevel: ModelThinkingLevel | undefined,
	levelMap: ThinkingLevelMap | undefined,
	configPath: string,
	fieldPath: string,
): void {
	if (levelMap) {
		const allMappedKeys = Object.fromEntries(Object.keys(levelMap).map((level) => [level, level]));
		const knownLevels = getSupportedThinkingLevels({ ...THINKING_LEVEL_VALIDATION_MODEL, thinkingLevelMap: allMappedKeys });
		for (const level of Object.keys(levelMap)) {
			if (!knownLevels.some((known) => known === level)) {
				throw invalidModelsJsonc(configPath, `${fieldPath}.thinking_level_map contains unknown Pi thinking level "${level}"`);
			}
		}
	}
	if (defaultLevel === undefined) return;
	const supportedLevels = getSupportedThinkingLevels({
		...THINKING_LEVEL_VALIDATION_MODEL,
		...(levelMap !== undefined ? { thinkingLevelMap: levelMap } : {}),
	});
	if (!supportedLevels.some((supported) => supported === defaultLevel)) {
		throw invalidModelsJsonc(configPath, `${fieldPath}.thinking_level "${defaultLevel}" is not supported by its Pi thinking_level_map`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
