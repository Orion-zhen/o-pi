import type { ProviderConfig as PiProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { invalidModelsJsonc } from "./errors.js";
import { allowsNonStandardSampling, resolveCompat } from "./presets.js";
import type { CompatPresetName, ModelsJsoncConfig, ReasoningEffort, SamplingDefaults } from "./schema.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CORE_PAYLOAD_FIELDS = new Set(["model", "messages", "input", "tools", "stream"]);

/** 单个模型的请求期附加配置；Pi 模型类型不允许扩展字段，因此保存在内部映射。 */
export interface RuntimeModelConfig {
	api: "openai-completions" | "openai-responses";
	compatPreset: CompatPresetName;
	reasoningEffort?: ReasoningEffort;
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
		const api = provider.api === "responses" ? "openai-responses" : "openai-completions";
		const compatPreset = provider.compat ?? "openai_compatible";
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
			const compat = resolveCompat(compatPreset, model.advanced?.compat);
			const dropParams = [...(provider.advanced?.drop_params ?? []), ...(model.advanced?.drop_params ?? [])];
			const extraBody = { ...providerExtraBody, ...modelExtraBody };
			runtimeModels.set(model.model, {
				api,
				compatPreset,
				...(model.reasoning_effort !== undefined ? { reasoningEffort: model.reasoning_effort } : {}),
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
				reasoning: model.reasoning_effort !== undefined && model.reasoning_effort !== "off",
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
				apiKey: provider.api_key ? provider.api_key : missingApiKeyEnv(providerId),
				api,
				...(provider.advanced?.headers !== undefined ? { headers: provider.advanced.headers } : {}),
				models,
			},
		};
	});
}

/** 将模型级 defaults 和 advanced payload 设置注入 OpenAI-compatible 请求体。 */
export function applyRuntimePayloadConfig(payload: unknown, runtime: RuntimeModelConfig): unknown {
	if (!isRecord(payload)) return payload;
	const next = { ...payload };
	for (const [key, value] of Object.entries(samplingDefaultsToPayload(runtime))) {
		if (value !== undefined) next[key] = value;
	}
	for (const [key, value] of Object.entries(reasoningEffortToPayload(runtime, next))) {
		if (value !== undefined) next[key] = value;
	}
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

function reasoningEffortToPayload(runtime: RuntimeModelConfig, payload: Record<string, unknown>): Record<string, unknown> {
	const effort = runtime.reasoningEffort;
	if (effort === undefined || effort === "off" || hasReasoningPayload(payload)) return {};
	if (runtime.api === "openai-responses") {
		return { reasoning: { effort } };
	}
	return { reasoning_effort: effort };
}

function hasReasoningPayload(payload: Record<string, unknown>): boolean {
	return "reasoning_effort" in payload || "reasoning" in payload || "thinking" in payload || "enable_thinking" in payload || "chat_template_kwargs" in payload;
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

function missingApiKeyEnv(providerId: string): string {
	const safeProvider = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	return `$PI_MODELS_JSONC_${safeProvider}_API_KEY`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
