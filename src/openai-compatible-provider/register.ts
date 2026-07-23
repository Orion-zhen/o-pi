import { createHash } from "node:crypto";

import {
	clampThinkingLevel,
	createProvider,
	type Api,
	type Context,
	type Model,
	type Provider,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
// coding-agent 的 extension loader 通过 compat 入口共享内置 API registry。
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createProviderAuth, resolvedProviderHeaders, resolveRefreshAuth } from "./auth.js";
import { registerThinkingDisplayResolver } from "../thinking-level/display-capability.js";
import { resolveHeadersOrThrow } from "./config-values.js";
import { fetchProviderModelsFromEndpoint, mergeDiscoveredModelConfigs, modelsEndpointUrl } from "./models-endpoint.js";
import {
	applyRuntimePayloadConfig,
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
	const providers = normalizedProviders.map((normalized) => {
		const providerConfig = config.providers[normalized.id];
		if (!providerConfig) throw new Error(`Missing normalized provider config: ${normalized.id}`);
		let provider: Provider | undefined;
		provider = createNativeProvider(normalized, providerConfig, configPath, () => {
			if (provider) pi.registerProvider(provider);
		});
		return provider;
	});
	const defaults = new Map<string, RuntimeModelConfig>();
	for (const normalized of normalizedProviders) {
		for (const [modelId, runtime] of normalized.runtimeModels) {
			defaults.set(runtimeKey(normalized.id, modelId), runtime);
		}
	}
	const normalizedById = new Map(normalizedProviders.map((provider) => [provider.id, provider]));
	const disposeThinkingDisplayResolver = registerThinkingDisplayResolver(pi.events, (model) => {
		const provider = normalizedById.get(model.provider);
		if (!provider) return undefined;
		const runtime = provider.runtimeModels.get(model.id) ?? provider.fallbackRuntime;
		return runtime.api === "openai-responses"
			&& runtime.reasoning
			&& runtime.thinkingPreset === "chat-template-enabled"
			&& !runtime.dropParams.includes("chat_template_kwargs")
			&& !Object.hasOwn(runtime.extraBody, "chat_template_kwargs")
			? "boolean"
			: undefined;
	});
	for (const provider of providers) pi.registerProvider(provider);
	pi.on("session_shutdown", disposeThinkingDisplayResolver);
	pi.on("model_select", (event) => {
		if (event.source === "restore") return;
		const runtime = defaults.get(runtimeKey(event.model.provider, event.model.id));
		if (runtime?.defaultThinkingLevel !== undefined) pi.setThinkingLevel(runtime.defaultThinkingLevel);
	});
	return providers;
}

/** 构造单个 provider；动态目录、认证、持久化和并发刷新由 pi-ai 生命周期管理。 */
export function createNativeProvider(
	normalized: NormalizedProvider,
	providerConfig: ProviderConfig,
	configPath: string,
	onModelsChanged?: () => void,
): Provider {
	const runtimeModels = new Map(normalized.runtimeModels);
	const streams = createRuntimeStreams(normalized, runtimeModels);
	const staticProvider = createProvider({
		id: normalized.id,
		name: normalized.name,
		baseUrl: normalized.baseUrl,
		auth: { apiKey: createProviderAuth(normalized.id, providerConfig) },
		models: normalized.models,
		api: streams,
	});
	const source = modelSource(providerConfig);
	let dynamicModels: Model<Api>[] = [];
	let refreshInFlight: Promise<void> | undefined;
	let refreshAllowsNetwork = false;
	const refreshModels: NonNullable<Provider["refreshModels"]> = (context) => {
		if (refreshInFlight) {
			return context.allowNetwork && !refreshAllowsNetwork
				? refreshInFlight.then(
					() => refreshModels(context),
					() => refreshModels(context),
				)
				: refreshInFlight;
		}
		refreshAllowsNetwork = context.allowNetwork;
		refreshInFlight = (async () => {
			try {
				const stored = await context.store.read();
				const restoredModels = restoreStoredModels(stored?.models ?? [], normalized, source);
				if (dynamicModels.length === 0 && restoredModels.length > 0) {
					dynamicModels = restoredModels;
					onModelsChanged?.();
				}
				if (!context.allowNetwork || context.signal?.aborted) return;

				const credential = context.credential?.type === "api_key" ? context.credential : undefined;
				const discovered = await fetchProviderModelsFromEndpoint(normalized.id, providerConfig, configPath, {
					requestAuth: resolveRefreshAuth(normalized.id, providerConfig, credential),
					...(context.signal ? { signal: context.signal } : {}),
				});
				if (context.signal?.aborted) return;
				const dynamicConfig: ModelsJsoncConfig = {
					providers: {
						[normalized.id]: {
							...providerConfig,
							models: mergeDiscoveredModelConfigs(providerConfig.models, discovered),
						},
					},
				};
				const [dynamic] = normalizeModelsJsoncConfig(dynamicConfig, configPath);
				if (!dynamic) return;
				await context.store.write({
					models: dynamic.models.map((model) => markStoredModel(model, source)),
					checkedAt: Date.now(),
				});
				for (const [modelId, runtime] of dynamic.runtimeModels) runtimeModels.set(modelId, runtime);
				dynamicModels = dynamic.models;
				onModelsChanged?.();
			} finally {
				refreshInFlight = undefined;
				refreshAllowsNetwork = false;
			}
		})();
		return refreshInFlight;
	};

	return {
		...staticProvider,
		getModels: () => mergeModelCatalogs(normalized.models, dynamicModels),
		refreshModels,
	};
}

const MODEL_SOURCE_HEADER = "x-o-pi-model-source";

function modelSource(provider: ProviderConfig): string {
	const identity = JSON.stringify({
		endpoint: modelsEndpointUrl(provider),
		api: provider.api ?? "openai-completions",
		compatPreset: provider.compatPreset ?? "openai-compatible",
		thinkingPreset: provider.thinkingPreset ?? "none",
		compat: provider.compat ?? {},
		models: provider.models ?? "auto",
	});
	return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function mergeModelCatalogs(baseline: readonly Model<Api>[], overlay: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of overlay) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function markStoredModel(model: Model<Api>, source: string): Model<Api> {
	return {
		...model,
		headers: { ...model.headers, [MODEL_SOURCE_HEADER]: source },
	};
}

function restoreStoredModels(
	storedModels: readonly Model<Api>[],
	provider: NormalizedProvider,
	source: string,
): Model<Api>[] {
	return storedModels
		.filter((model) => model.provider === provider.id && model.headers?.[MODEL_SOURCE_HEADER] === source)
		.map((model) => {
			const { headers: storedHeaders, ...storedModel } = model;
			const headers = { ...storedHeaders };
			delete headers[MODEL_SOURCE_HEADER];
			return {
				...storedModel,
				provider: provider.id,
				baseUrl: provider.baseUrl,
				api: provider.api,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			};
		});
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
			return apiFor(model).stream(
				model,
				withoutUnsupportedToolResultImages(model.api, context),
				withRuntimeStreamOptions(model, runtimeFor(model), options),
			);
		},
		streamSimple(model, context, options) {
			return apiFor(model).streamSimple(
				model,
				withoutUnsupportedToolResultImages(model.api, context),
				withRuntimeSimpleOptions(model, runtimeFor(model), options),
			);
		},
	};
}

function withoutUnsupportedToolResultImages(api: Api, context: Context): Context {
	if (api !== "openai-completions") return context;
	let changed = false;
	const messages = context.messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const content = message.content.filter((block) => block.type !== "image");
		if (content.length === message.content.length) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? { ...context, messages } : context;
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
	const thinkingLevel = clampThinkingLevel(model, options?.reasoning ?? "off");
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
	if (!configured) return options?.headers ? { headers: options.headers } : {};
	const headers = { ...options?.headers };
	const providerHeaders = resolvedProviderHeaders(options?.env);
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
	thinkingLevel: Parameters<typeof applyRuntimePayloadConfig>[2],
	next: StreamOptions["onPayload"],
): NonNullable<StreamOptions["onPayload"]> {
	return async (payload, model) => {
		const patched = applyRuntimePayloadConfig(payload, runtime, thinkingLevel);
		if (!next) return patched;
		const transformed = await next(patched, model);
		return transformed === undefined ? patched : transformed;
	};
}

function streamThinkingLevel(options: StreamOptions | undefined): Parameters<typeof applyRuntimePayloadConfig>[2] {
	if (!options || !("reasoningEffort" in options)) return "off";
	const value: unknown = options.reasoningEffort;
	return isModelThinkingLevel(value) ? value : "off";
}

function isModelThinkingLevel(value: unknown): value is Exclude<Parameters<typeof applyRuntimePayloadConfig>[2], undefined> {
	return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function runtimeKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}
