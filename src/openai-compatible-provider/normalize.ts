import {
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { invalidModelsJsonc } from "./errors.js";
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
	headers?: Record<string, string>;
	compat: NonNullable<Model<"openai-completions">["compat"]>;
}

/** 归一化后的 provider，供原生 pi-ai Provider 构造器消费。 */
export interface NormalizedProvider {
	id: string;
	name: string;
	baseUrl: string;
	api: "openai-completions" | "openai-responses";
	models: Model<Api>[];
	runtimeModels: Map<string, RuntimeModelConfig>;
	fallbackRuntime: RuntimeModelConfig;
}

/** 将配置转换成原生 Provider/Model 结构，只保留必要的请求期扩展状态。 */
export function normalizeModelsJsoncConfig(config: ModelsJsoncConfig, configPath: string): NormalizedProvider[] {
	return Object.entries(config.providers).map(([providerId, provider]) => {
		const api = provider.api ?? "openai-completions";
		const compatPreset = provider.compatPreset ?? "openai-compatible";
		const providerThinkingPreset = provider.thinkingPreset ?? "none";
		const providerExtraBody = provider.extraBody ?? {};
		assertNoCorePayloadFields(providerExtraBody, configPath, `providers.${providerId}.extraBody`);

		const seenModels = new Set<string>();
		const runtimeModels = new Map<string, RuntimeModelConfig>();
		const configuredModels = Array.isArray(provider.models) ? provider.models : [];
		const models: Model<Api>[] = configuredModels.map((entry, index) => {
			const model = typeof entry === "string" ? { id: entry } : entry;
			const modelApi = model.api ?? api;
			const thinkingPreset = model.thinkingPreset ?? providerThinkingPreset;
			if (seenModels.has(model.id)) {
				throw invalidModelsJsonc(configPath, `provider "${providerId}" contains duplicate model "${model.id}"`);
			}
			seenModels.add(model.id);

			const modelExtraBody = model.extraBody ?? {};
			assertNoCorePayloadFields(modelExtraBody, configPath, `providers.${providerId}.models[${index}].extraBody`);
			assertSamplingDefaultsSupported(model.defaults, compatPreset, configPath, `providers.${providerId}.models[${index}].defaults`);
			const resolvedCompat = resolveCompat(compatPreset, thinkingPreset, provider.compat, model.compat);
			const runtimeCompat = modelApi === "openai-responses" ? resolvedCompat : completionsCompat(resolvedCompat);
			const compat = modelApi === "openai-responses"
				? responsesCompat(resolvedCompat, provider.compat, model.compat)
				: runtimeCompat;
			const dropParams = [...(provider.dropParams ?? []), ...(model.dropParams ?? [])];
			const extraBody = { ...providerExtraBody, ...modelExtraBody };
			const inferredReasoning = model.defaultThinkingLevel !== undefined || model.thinkingLevelMap !== undefined;
			if (model.reasoning === false && inferredReasoning) {
				throw invalidModelsJsonc(
					configPath,
					`providers.${providerId}.models[${index}].reasoning=false conflicts with defaultThinkingLevel/thinkingLevelMap`,
				);
			}
			const reasoning = model.reasoning ?? inferredReasoning;
			assertValidThinkingConfig(model.defaultThinkingLevel, model.thinkingLevelMap, configPath, `providers.${providerId}.models[${index}]`);
			runtimeModels.set(model.id, {
				api: modelApi,
				compatPreset,
				thinkingPreset,
				reasoning,
				...(model.defaultThinkingLevel !== undefined ? { defaultThinkingLevel: model.defaultThinkingLevel } : {}),
				...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
				...(model.defaults !== undefined ? { defaults: model.defaults } : {}),
				dropParams,
				extraBody,
				...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
				...(provider.maxRetries !== undefined ? { maxRetries: provider.maxRetries } : {}),
				...(model.headers !== undefined ? { headers: model.headers } : {}),
				compat: runtimeCompat,
			});

			return {
				id: model.id,
				name: model.name ?? model.id,
				api: modelApi,
				provider: providerId,
				baseUrl: model.baseUrl ?? provider.baseUrl,
				reasoning,
				...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
				input: model.input ?? ["text"],
				cost: model.cost ?? { ...ZERO_COST },
				contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
				maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
				compat,
			};
		});

		const fallbackRuntime: RuntimeModelConfig = {
			api,
			compatPreset,
			thinkingPreset: providerThinkingPreset,
			reasoning: false,
			dropParams: [...(provider.dropParams ?? [])],
			extraBody: { ...providerExtraBody },
			...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
			...(provider.maxRetries !== undefined ? { maxRetries: provider.maxRetries } : {}),
			compat: resolveCompat(compatPreset, providerThinkingPreset, provider.compat, undefined),
		};

		return {
			id: providerId,
			name: provider.name ?? providerId,
			baseUrl: provider.baseUrl,
			api,
			models,
			runtimeModels,
			fallbackRuntime,
		};
	});
}

/** 将模型级 defaults 和 advanced payload 设置注入 OpenAI-compatible 请求体。 */
export function applyRuntimePayloadConfig(
	payload: unknown,
	runtime: RuntimeModelConfig,
	thinkingLevel: ModelThinkingLevel | undefined = "off",
): unknown {
	if (!isRecord(payload)) return payload;
	const next = { ...payload };
	const samplingDefaults = samplingDefaultsToPayload(runtime);
	const configuredMaxTokensField = runtime.defaults?.maxTokens !== undefined ? maxTokensField(runtime) : undefined;
	for (const [key, value] of Object.entries(samplingDefaults)) {
		if (value === undefined) continue;
		if (key === configuredMaxTokensField && typeof value === "number") {
			const generated = next[key];
			next[key] = typeof generated === "number" && Number.isFinite(generated)
				? Math.min(generated, value)
				: value;
		} else if (next[key] === undefined) {
			next[key] = value;
		}
	}
	if (thinkingLevel !== undefined) applyResponsesThinkingPreset(next, runtime, thinkingLevel);
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
	copyIfDefined(payload, "top_p", defaults.topP);
	copyIfDefined(payload, "presence_penalty", defaults.presencePenalty);
	copyIfDefined(payload, "frequency_penalty", defaults.frequencyPenalty);
	copyIfDefined(payload, "seed", defaults.seed);
	copyIfDefined(payload, "stop", defaults.stop);
	if (allowsNonStandardSampling(runtime.compatPreset)) {
		copyIfDefined(payload, "top_k", defaults.topK);
		copyIfDefined(payload, "min_p", defaults.minP);
		copyIfDefined(payload, "repetition_penalty", defaults.repetitionPenalty);
	}
	if (defaults.maxTokens !== undefined) {
		payload[maxTokensField(runtime)] = defaults.maxTokens;
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
		case "qwen-chat-template":
			payload.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
			return;
		case "chat-template-enabled":
			payload.chat_template_kwargs = { enable_thinking: enabled };
			return;
		case "chat-template-effort":
			if (effort !== undefined) payload.chat_template_kwargs = { reasoning_effort: effort };
			return;
		case "string-thinking":
			if (effort !== undefined) payload.thinking = effort;
			return;
		case "ant-ling": {
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

function completionsCompat(
	compat: NonNullable<Model<"openai-completions">["compat"]>,
): NonNullable<Model<"openai-completions">["compat"]> {
	const cleaned = { ...compat };
	Reflect.deleteProperty(cleaned, "supportsToolSearch");
	return cleaned;
}

function assertSamplingDefaultsSupported(
	defaults: SamplingDefaults | undefined,
	compatPreset: CompatPresetName,
	configPath: string,
	fieldPath: string,
): void {
	if (!defaults || allowsNonStandardSampling(compatPreset)) return;
	for (const field of ["topK", "minP", "repetitionPenalty"] as const) {
		if (defaults[field] !== undefined) {
			throw invalidModelsJsonc(configPath, `${fieldPath}.${field} requires compatPreset local, qwen, or deepseek`);
		}
	}
}

function responsesCompat(
	compat: NonNullable<Model<"openai-completions">["compat"]>,
	providerCompat: Model<"openai-completions">["compat"] | Model<"openai-responses">["compat"],
	modelCompat: Model<"openai-completions">["compat"] | Model<"openai-responses">["compat"],
): NonNullable<Model<"openai-responses">["compat"]> {
	const supportsToolSearch = compatBoolean(modelCompat, "supportsToolSearch")
		?? compatBoolean(providerCompat, "supportsToolSearch");
	return {
		...(compat.supportsDeveloperRole !== undefined ? { supportsDeveloperRole: compat.supportsDeveloperRole } : {}),
		...(compat.sessionAffinityFormat !== undefined ? { sessionAffinityFormat: compat.sessionAffinityFormat } : {}),
		...(compat.supportsLongCacheRetention !== undefined ? { supportsLongCacheRetention: compat.supportsLongCacheRetention } : {}),
		...(supportsToolSearch !== undefined ? { supportsToolSearch } : {}),
	};
}

function compatBoolean(value: object | undefined, key: string): boolean | undefined {
	if (!value || !(key in value)) return undefined;
	const candidate: unknown = Reflect.get(value, key);
	return typeof candidate === "boolean" ? candidate : undefined;
}

function supportsReasoningEffort(compat: NonNullable<Model<"openai-completions">["compat"]>): boolean {
	return "supportsReasoningEffort" in compat && compat.supportsReasoningEffort === true;
}

function maxTokensField(runtime: RuntimeModelConfig): string {
	if (runtime.api === "openai-responses") return "max_output_tokens";
	const value = hasMaxTokensField(runtime.compat) ? runtime.compat.maxTokensField : undefined;
	if (value === "max_tokens" || value === "max_completion_tokens") return value;
	return "max_completion_tokens";
}

function hasMaxTokensField(value: NonNullable<Model<"openai-completions">["compat"]>): value is NonNullable<Model<"openai-completions">["compat"]> & {
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
				throw invalidModelsJsonc(configPath, `${fieldPath}.thinkingLevelMap contains unknown Pi thinking level "${level}"`);
			}
		}
	}
	if (defaultLevel === undefined) return;
	const supportedLevels = getSupportedThinkingLevels({
		...THINKING_LEVEL_VALIDATION_MODEL,
		...(levelMap !== undefined ? { thinkingLevelMap: levelMap } : {}),
	});
	if (!supportedLevels.some((supported) => supported === defaultLevel)) {
		throw invalidModelsJsonc(configPath, `${fieldPath}.defaultThinkingLevel "${defaultLevel}" is not supported by its Pi thinkingLevelMap`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
