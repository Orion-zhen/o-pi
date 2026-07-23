import { invalidModelsJsonc } from "./errors.js";
import { defaultApiKeyConfig } from "./provider-defaults.js";
import type { ModelConfig, ProviderConfig } from "./schema.js";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "./config-values.js";

const DEFAULT_MODELS_ENDPOINT = "models";
const DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 500;

export interface ModelsEndpointResponse {
	ok: boolean;
	status: number;
	statusText?: string;
	text(): Promise<string>;
}

export interface ModelsEndpointRequest {
	method: "GET";
	headers: Record<string, string>;
	signal: AbortSignal;
}

export type ModelsEndpointFetch = (url: string, init: ModelsEndpointRequest) => Promise<ModelsEndpointResponse>;

export interface ModelsEndpointAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	keyless?: boolean;
}

export interface FetchProviderModelsOptions {
	fetch?: ModelsEndpointFetch;
	env?: Record<string, string>;
	requestAuth?: ModelsEndpointAuth;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function fetchProviderModelsFromEndpoint(
	providerId: string,
	provider: ProviderConfig,
	configPath: string,
	options: FetchProviderModelsOptions = {},
): Promise<ModelConfig[]> {
	let url: string;
	let headers: Record<string, string>;
	try {
		url = modelsEndpointUrl(provider);
		headers = buildModelsEndpointHeaders(providerId, provider, options.env, options.requestAuth);
	} catch (error) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint configuration failed: ${stringifyError(error)}`);
	}
	const fetcher = options.fetch ?? defaultFetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const abortFromCaller = () => controller.abort();
	if (options.signal?.aborted) abortFromCaller();
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

	try {
		let response: ModelsEndpointResponse;
		try {
			response = await fetcher(url, { method: "GET", headers, signal: controller.signal });
		} catch (error) {
			const reason = isAbortError(error) ? (timedOut ? `timed out after ${timeoutMs}ms` : "cancelled") : stringifyError(error);
			throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint request failed: ${reason}`);
		}

		let responseText = "";
		try {
			responseText = await response.text();
		} catch (error) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint response cannot be read: ${stringifyError(error)}`);
		}

		if (!response.ok) {
			throw invalidModelsJsonc(
				configPath,
				`provider "${providerId}" models endpoint returned HTTP ${response.status}${formatStatusText(response.statusText)}${formatErrorBody(responseText)}`,
			);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(responseText);
		} catch {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint did not return valid JSON`);
		}

		return parseModelsEndpointPayload(payload, configPath, providerId);
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

/** 以 endpoint 元数据为基底，手写模型按字段覆盖；保留手写顺序并追加远端独有模型。 */
export function mergeDiscoveredModelConfigs(
	configured: ProviderConfig["models"],
	discovered: readonly ModelConfig[],
): ModelConfig[] {
	if (!Array.isArray(configured)) return discovered.map((model) => ({ ...model }));

	const discoveredById = new Map(discovered.map((model) => [model.id, model]));
	const merged = configured.map((entry) => {
		const model = typeof entry === "string" ? { id: entry } : entry;
		const remote = discoveredById.get(model.id);
		return remote ? { ...remote, ...model } : { ...model };
	});
	const configuredIds = new Set(merged.map((model) => model.id));
	for (const model of discovered) {
		if (!configuredIds.has(model.id)) merged.push({ ...model });
	}
	return merged;
}

export function modelsEndpointUrl(provider: ProviderConfig): string {
	return new URL(provider.modelsEndpoint ?? DEFAULT_MODELS_ENDPOINT, ensureTrailingSlash(provider.baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function buildModelsEndpointHeaders(
	providerId: string,
	provider: ProviderConfig,
	env: Record<string, string> | undefined,
	requestAuth: ModelsEndpointAuth | undefined,
): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (requestAuth) {
		if (requestAuth.headers) Object.assign(headers, requestAuth.headers);
		if (!requestAuth.keyless && requestAuth.apiKey && !hasAuthHeader(headers)) {
			headers.Authorization = `Bearer ${requestAuth.apiKey}`;
		}
		return headers;
	}

	const customHeaders = resolveHeadersOrThrow(provider.headers, `provider "${providerId}" models endpoint`, env);
	if (customHeaders) Object.assign(headers, customHeaders);
	if (hasAuthHeader(headers)) return headers;

	const apiKeyConfig = provider.apiKey && provider.apiKey.length > 0 ? provider.apiKey : defaultApiKeyConfig(providerId);
	const apiKey = resolveConfigValueOrThrow(apiKeyConfig, `API key for provider "${providerId}" models endpoint`, env);
	if (apiKey !== "EMPTY") headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

function hasAuthHeader(headers: Record<string, string>): boolean {
	return Object.keys(headers).some((key) => {
		const normalized = key.toLowerCase();
		return normalized === "authorization" || normalized === "cf-aig-authorization";
	});
}

function parseModelsEndpointPayload(payload: unknown, configPath: string, providerId: string): ModelConfig[] {
	const entries = extractModelEntries(payload, configPath, providerId);
	const models: ModelConfig[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const model = parseModelEntry(entries[index], configPath, providerId, index);
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	if (models.length === 0) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint returned no models`);
	}
	return models;
}

function extractModelEntries(payload: unknown, configPath: string, providerId: string): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (isRecord(payload)) {
		if (Array.isArray(payload.data)) return payload.data;
		if (Array.isArray(payload.models)) return payload.models;
	}
	throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint JSON must be an array or contain a data/models array`);
}

function parseModelEntry(entry: unknown, configPath: string, providerId: string, index: number): ModelConfig {
	if (typeof entry === "string" && entry.trim().length > 0) return { id: entry };
	if (!isRecord(entry)) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint data[${index}] must be an object or non-empty string`);
	}

	const id = firstString(entry, ["id", "model"]);
	if (!id) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint data[${index}].id is required`);
	}

	const model: ModelConfig = { id };
	const displayName = firstString(entry, ["display_name", "name"]);
	if (displayName && displayName !== id) model.name = displayName;
	const contextWindow = firstPositiveNumber(entry, ["context_window", "context_length", "max_context_length", "max_model_len", "max_sequence_length"]);
	if (contextWindow !== undefined) model.contextWindow = contextWindow;
	const maxTokens = firstPositiveNumber(entry, ["max_output_tokens", "max_completion_tokens"])
		?? firstPositiveNumber(nestedRecord(entry, "top_provider"), ["max_completion_tokens", "max_output_tokens"]);
	if (maxTokens !== undefined) model.maxTokens = maxTokens;
	if (supportsImageInput(entry)) model.input = ["text", "image"];
	return model;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

function firstPositiveNumber(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

function supportsImageInput(record: Record<string, unknown>): boolean {
	return hasImageModality(record.input_modalities)
		|| hasImageModality(nestedRecord(record, "architecture")?.input_modalities)
		|| hasImageModality(nestedRecord(record, "modalities")?.input)
		|| hasImageModality(record.modalities);
}

function hasImageModality(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return value.some((item) => typeof item === "string" && ["image", "vision"].includes(item.toLowerCase()));
}

function formatStatusText(value: string | undefined): string {
	return value && value.trim().length > 0 ? ` ${value}` : "";
}

function formatErrorBody(value: string): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (!trimmed) return "";
	const snippet = trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…` : trimmed;
	return `: ${snippet}`;
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultFetch: ModelsEndpointFetch = async (url, init) => fetch(url, init);
