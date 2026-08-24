import {
	clampThinkingLevel,
	createProvider,
	type Api,
	type ApiKeyCredential,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
// coding-agent 的 extension loader 通过 compat 入口共享内置 API registry。
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createProviderAuth, resolvedProviderHeaders } from "./auth.js";
import { resolveHeadersOrThrow } from "./config-values.js";
import { fetchProviderModelsFromEndpoint, mergeDiscoveredModelConfigs } from "./models-endpoint.js";
import {
	applyRuntimePayloadConfig,
	isModelThinkingLevel,
	normalizeModelsJsoncConfig,
	type NormalizedProvider,
	type RuntimeModelConfig,
} from "./normalize.js";
import type { ModelsJsoncConfig, ProviderConfig } from "./schema.js";

/** 将解析后的用户配置注册为完整的原生 pi-ai Provider。 */
export function registerOpenAICompatibleProviders(
	pi: ExtensionAPI,
	config: ModelsJsoncConfig,
	configPath: string,
): Provider[] {
	const normalizedProviders = normalizeModelsJsoncConfig(config, configPath);
	const providers = normalizedProviders.map((normalized) => createNativeProvider(normalized, normalized.providerConfig, configPath));
	const runtimeByModel = new Map<string, RuntimeModelConfig>();
	for (const normalized of normalizedProviders) {
		for (const [modelId, runtime] of normalized.runtimeModels) {
			runtimeByModel.set(runtimeKey(normalized.id, modelId), runtime);
		}
	}
	for (const provider of providers) pi.registerProvider(provider);
	pi.on("model_select", (event) => {
		if (event.source === "restore") return;
		const runtime = runtimeByModel.get(runtimeKey(event.model.provider, event.model.id));
		if (runtime?.defaultThinkingLevel !== undefined) pi.setThinkingLevel(runtime.defaultThinkingLevel);
	});
	return providers;
}

/** 构造单个 provider；动态目录、认证、持久化和并发刷新由 pi-ai 生命周期管理。 */
function createNativeProvider(
	normalized: NormalizedProvider,
	providerConfig: ProviderConfig,
	configPath: string,
): Provider {
	const runtimeModels = new Map(normalized.runtimeModels);
	const streams = createRuntimeStreams(normalized, runtimeModels);
	return createProvider({
		id: normalized.id,
		name: normalized.name,
		baseUrl: normalized.baseUrl,
		auth: { apiKey: createProviderAuth(normalized.id, providerConfig) },
		models: normalized.models,
		fetchModels: async (context) => {
			const credential = requireApiKeyCredential(normalized.id, context.credential);
			const discovered = await fetchProviderModelsFromEndpoint(
				normalized.id,
				providerConfig,
				configPath,
				credential,
				context.signal,
			);
			if (context.signal.aborted) return [];
			const dynamicConfig: ModelsJsoncConfig = {
				providers: {
					[normalized.id]: {
						...providerConfig,
						models: mergeDiscoveredModelConfigs(providerConfig.models, discovered),
					},
				},
			};
			const dynamic = normalizeModelsJsoncConfig(dynamicConfig, configPath)[0];
			if (!dynamic) throw new Error(`Provider "${normalized.id}" models could not be normalized`);
			return dynamic.models;
		},
		api: streams,
	});
}

function requireApiKeyCredential(providerId: string, credential: unknown): ApiKeyCredential {
	if (!isApiKeyCredential(credential)) {
		throw new TypeError(`Provider "${providerId}" model refresh requires an API key credential`);
	}
	return credential;
}

function isApiKeyCredential(value: unknown): value is ApiKeyCredential {
	return typeof value === "object"
		&& value !== null
		&& (value as { type?: unknown }).type === "api_key";
}

function createRuntimeStreams(
	provider: NormalizedProvider,
	runtimeModels: ReadonlyMap<string, RuntimeModelConfig>,
): ProviderStreams {
	const completions = openAICompletionsApi();
	const responses = openAIResponsesApi();
	const apiFor = (model: Model<Api>) => model.api === "openai-responses" ? responses : completions;
	const runtimeFor = (model: Model<Api>) => runtimeModels.get(model.id) ?? provider.fallbackRuntime;
	return {
		stream(model, context, options) {
			return apiFor(model).stream(model, context, withRuntimeStreamOptions(model, runtimeFor(model), options));
		},
		streamSimple(model, context, options) {
			return apiFor(model).streamSimple(model, context, withRuntimeSimpleOptions(model, runtimeFor(model), options));
		},
	};
}

function withRuntimeStreamOptions(
	model: Model<Api>,
	runtime: RuntimeModelConfig,
	options: StreamOptions | undefined,
): StreamOptions {
	return {
		...options,
		...runtimeHeaders(model, runtime, options),
		...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
		...(runtime.maxRetries !== undefined ? { maxRetries: runtime.maxRetries } : {}),
		onPayload: composePayloadTransform(runtime, streamThinkingLevel(options), options?.onPayload),
	};
}

function withRuntimeSimpleOptions(
	model: Model<Api>,
	runtime: RuntimeModelConfig,
	options: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
	const thinkingLevel = clampThinkingLevel(model, resolveThinkingLevel(options?.reasoning, "reasoning"));
	return {
		...options,
		...runtimeHeaders(model, runtime, options),
		...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
		...(runtime.maxRetries !== undefined ? { maxRetries: runtime.maxRetries } : {}),
		onPayload: composePayloadTransform(runtime, thinkingLevel, options?.onPayload),
	};
}

function runtimeHeaders(
	model: Model<Api>,
	runtime: RuntimeModelConfig,
	options: StreamOptions | undefined,
): Pick<StreamOptions, "headers"> {
	const configured = resolveHeadersOrThrow(runtime.headers, `model "${model.provider}/${model.id}"`, options?.env);
	const providerHeaders = resolvedProviderHeaders(model.provider, options?.env);
	if (!configured) return options?.headers ? { headers: options.headers } : {};
	const headers = { ...options?.headers };
	for (const [name, value] of Object.entries(configured)) {
		const existingName = findHeaderName(headers, name);
		const providerName = findHeaderName(providerHeaders, name);
		const callerOverrode = existingName !== undefined
			&& (providerName === undefined || headers[existingName] !== providerHeaders?.[providerName]);
		if (callerOverrode) continue;
		if (existingName !== undefined) delete headers[existingName];
		headers[name] = value;
	}
	return { headers };
}

function findHeaderName(headers: Record<string, unknown> | undefined, expected: string): string | undefined {
	const normalized = expected.toLowerCase();
	return Object.keys(headers ?? {}).find((name) => name.toLowerCase() === normalized);
}

function composePayloadTransform(
	runtime: RuntimeModelConfig,
	thinkingLevel: ModelThinkingLevel,
	next: StreamOptions["onPayload"],
): NonNullable<StreamOptions["onPayload"]> {
	return async (payload, model) => {
		const patched = applyRuntimePayloadConfig(payload, runtime, thinkingLevel);
		if (!next) return patched;
		const transformed = await next(patched, model);
		return transformed === undefined ? patched : transformed;
	};
}

function streamThinkingLevel(options: StreamOptions | undefined): ModelThinkingLevel {
	const value = options && "reasoningEffort" in options ? options.reasoningEffort : undefined;
	return resolveThinkingLevel(value, "reasoningEffort");
}

function resolveThinkingLevel(value: unknown, field: string): ModelThinkingLevel {
	if (value === undefined) return "off";
	if (!isModelThinkingLevel(value)) throw new TypeError(`OpenAI-compatible ${field} is invalid`);
	return value;
}

function runtimeKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}
