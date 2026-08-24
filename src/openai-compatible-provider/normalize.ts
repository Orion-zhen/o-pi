import {
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { invalidModelsJsonc } from "./errors.js";
import { resolveCompat } from "./thinking-presets.js";
import type {
	ModelConfig,
	ModelsJsoncConfig,
	OpenAICompatConfig,
	ProviderConfig,
	ThinkingPresetName,
} from "./schema.js";

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
	thinkingPreset: ThinkingPresetName;
	reasoning: boolean;
	defaultThinkingLevel?: ModelThinkingLevel;
	thinkingLevelMap?: ThinkingLevelMap;
	dropParams: string[];
	extraBody: Record<string, unknown>;
	timeoutMs?: number;
	maxRetries?: number;
	headers?: Record<string, string>;
	compat: OpenAICompatConfig;
}

/** 归一化后的 provider，供原生 pi-ai Provider 构造器消费。 */
export interface NormalizedProvider {
	id: string;
	name: string;
	providerConfig: ProviderConfig;
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
		const providerThinkingPreset = provider.thinkingPreset ?? "none";
		const providerExtraBody = provider.extraBody ?? {};
		assertNoCorePayloadFields(providerExtraBody, configPath, `providers.${providerId}.extraBody`);
		assertNoCoreDropParams(provider.dropParams, configPath, `providers.${providerId}.dropParams`);

		const runtimeModels = new Map<string, RuntimeModelConfig>();
		const configuredModels = prepareConfiguredModels(
			Array.isArray(provider.models) ? provider.models : [],
			providerThinkingPreset,
			providerId,
			configPath,
		);
		const models: Model<Api>[] = configuredModels.map(({ model, index }) => {
			const modelApi = model.api ?? api;
			const thinkingPreset = model.thinkingPreset ?? providerThinkingPreset;

			const compat = resolveCompat(thinkingPreset, provider.compat, model.compat);
			assertNoCoreDropParams(model.dropParams, configPath, `providers.${providerId}.models[${index}].dropParams`);
			const dropParams = [...(provider.dropParams ?? []), ...(model.dropParams ?? [])];
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
				thinkingPreset,
				reasoning,
				...(model.defaultThinkingLevel !== undefined ? { defaultThinkingLevel: model.defaultThinkingLevel } : {}),
				...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
				dropParams,
				extraBody: { ...providerExtraBody },
				...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
				...(provider.maxRetries !== undefined ? { maxRetries: provider.maxRetries } : {}),
				...(model.headers !== undefined ? { headers: model.headers } : {}),
				compat,
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
				...(model.samplingParams !== undefined ? { samplingParams: model.samplingParams } : {}),
				compat,
			};
		});

		const fallbackRuntime: RuntimeModelConfig = {
			api,
			thinkingPreset: providerThinkingPreset,
			reasoning: false,
			dropParams: [...(provider.dropParams ?? [])],
			extraBody: { ...providerExtraBody },
			...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
			...(provider.maxRetries !== undefined ? { maxRetries: provider.maxRetries } : {}),
			compat: resolveCompat(providerThinkingPreset, provider.compat, undefined),
		};

		return {
			id: providerId,
			name: provider.name ?? providerId,
			providerConfig: provider,
			baseUrl: provider.baseUrl,
			api,
			models,
			runtimeModels,
			fallbackRuntime,
		};
	});
}

interface PreparedModelConfig {
	model: ModelConfig;
	index: number;
}

/** 校验原始目录，并在 model-suffix 预设下把已知等级变体折叠到基础模型。 */
function prepareConfiguredModels(
	entries: readonly (string | ModelConfig)[],
	providerThinkingPreset: ThinkingPresetName,
	providerId: string,
	configPath: string,
): PreparedModelConfig[] {
	const prepared = entries.map((entry, index) => ({
		model: typeof entry === "string" ? { id: entry } : entry,
		index,
	}));
	const byId = new Map<string, PreparedModelConfig>();
	for (const entry of prepared) {
		if (byId.has(entry.model.id)) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" contains duplicate model "${entry.model.id}"`);
		}
		byId.set(entry.model.id, entry);
	}

	const variantsByBase = new Map<string, Set<ModelThinkingLevel>>();
	const hiddenVariants = new Set<string>();
	for (const entry of prepared) {
		const variant = parseModelSuffixVariant(entry.model.id);
		if (!variant) continue;
		const base = byId.get(variant.baseId);
		if (!base || effectiveThinkingPreset(base.model, providerThinkingPreset) !== "model-suffix") continue;
		let variants = variantsByBase.get(variant.baseId);
		if (!variants) {
			variants = new Set();
			variantsByBase.set(variant.baseId, variants);
		}
		variants.add(variant.level);
		hiddenVariants.add(entry.model.id);
	}

	return prepared.flatMap((entry) => {
		if (hiddenVariants.has(entry.model.id)) return [];
		const variants = variantsByBase.get(entry.model.id);
		if (!variants) return [entry];
		const inferredMap: ThinkingLevelMap = {};
		for (const level of MODEL_THINKING_LEVEL_VALUES) {
			if (variants.has(level)) inferredMap[level] = level;
			else if (level !== "off") inferredMap[level] = null;
		}
		return [{
			...entry,
			model: {
				...entry.model,
				thinkingLevelMap: { ...inferredMap, ...entry.model.thinkingLevelMap },
			},
		}];
	});
}

function effectiveThinkingPreset(model: ModelConfig, providerPreset: ThinkingPresetName): ThinkingPresetName {
	return model.thinkingPreset ?? providerPreset;
}

function parseModelSuffixVariant(id: string): { baseId: string; level: ModelThinkingLevel } | undefined {
	const separator = id.lastIndexOf(":");
	if (separator <= 0) return undefined;
	const level = id.slice(separator + 1);
	if (!isModelThinkingLevel(level)) return undefined;
	return { baseId: id.slice(0, separator), level };
}

/** 将 thinking 和 provider 级 payload 扩展应用到 OpenAI-compatible 请求体。 */
export function applyRuntimePayloadConfig(
	payload: unknown,
	runtime: RuntimeModelConfig,
	thinkingLevel: ModelThinkingLevel = "off",
): Record<string, unknown> {
	if (!isRecord(payload)) throw new TypeError("OpenAI-compatible payload must be an object");
	if (!isModelThinkingLevel(thinkingLevel)) throw new TypeError("OpenAI-compatible thinking level is invalid");
	const next = { ...payload };
	applyResponsesThinkingPreset(next, runtime, thinkingLevel);
	for (const [key, value] of Object.entries(runtime.extraBody)) {
		next[key] = value;
	}
	for (const key of runtime.dropParams) {
		delete next[key];
	}
	return next;
}

function applyResponsesThinkingPreset(
	payload: Record<string, unknown>,
	runtime: RuntimeModelConfig,
	thinkingLevel: ModelThinkingLevel,
): void {
	if (runtime.api !== "openai-responses" || runtime.thinkingPreset === "openai" || runtime.thinkingPreset === "model-suffix") return;
	if (!runtime.reasoning) return;
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

export function applyModelSuffixPayload(
	payload: Record<string, unknown>,
	model: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
): void {
	stripThinkingPayload(payload);
	const mapped = model.thinkingLevelMap?.[thinkingLevel];
	const useSuffix = mapped !== null && (thinkingLevel !== "off" || mapped !== undefined);
	payload.model = useSuffix ? `${model.id}:${thinkingLevel}` : model.id;
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

function supportsReasoningEffort(compat: OpenAICompatConfig): boolean {
	return compat.supportsReasoningEffort === true;
}

function assertNoCorePayloadFields(value: Record<string, unknown>, configPath: string, fieldPath: string): void {
	for (const key of Object.keys(value)) {
		if (CORE_PAYLOAD_FIELDS.has(key)) {
			throw invalidModelsJsonc(configPath, `${fieldPath}.${key} cannot override core request field "${key}"`);
		}
	}
}

function assertNoCoreDropParams(values: readonly string[] | undefined, configPath: string, fieldPath: string): void {
	for (const key of values ?? []) {
		if (CORE_PAYLOAD_FIELDS.has(key)) {
			throw invalidModelsJsonc(configPath, `${fieldPath} cannot remove core request field "${key}"`);
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

const MODEL_THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_THINKING_LEVELS: ReadonlySet<string> = new Set(MODEL_THINKING_LEVEL_VALUES);

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && MODEL_THINKING_LEVELS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
