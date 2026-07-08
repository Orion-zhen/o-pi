import { invalidModelsJsonc } from "./errors.js";
import { defaultApiKeyConfig } from "./provider-defaults.js";
import type { ModelConfig, ModelsJsoncConfig, ProviderConfig } from "./schema.js";
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

export interface ResolveAutoModelsOptions {
	fetch?: ModelsEndpointFetch;
	env?: Record<string, string>;
	timeoutMs?: number;
}

/** 将 models 省略或写成 "auto" 的 provider 展开为从 /models 发现到的模型列表。 */
export async function resolveAutoModelsJsoncConfig(
	config: ModelsJsoncConfig,
	configPath: string,
	options: ResolveAutoModelsOptions = {},
): Promise<ModelsJsoncConfig> {
	let changed = false;
	const providers: Record<string, ProviderConfig> = {};
	for (const [providerId, provider] of Object.entries(config.providers)) {
		if (provider.models !== undefined && provider.models !== "auto") {
			providers[providerId] = provider;
			continue;
		}
		changed = true;
		providers[providerId] = {
			...provider,
			models: await fetchProviderModelsFromEndpoint(providerId, provider, configPath, options),
		};
	}
	return changed ? { providers } : config;
}

export async function fetchProviderModelsFromEndpoint(
	providerId: string,
	provider: ProviderConfig,
	configPath: string,
	options: ResolveAutoModelsOptions = {},
): Promise<ModelConfig[]> {
	let url: string;
	let headers: Record<string, string>;
	try {
		url = buildModelsEndpointUrl(provider.base_url, provider.models_endpoint);
		headers = buildModelsEndpointHeaders(providerId, provider, options.env);
	} catch (error) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint configuration failed: ${stringifyError(error)}`);
	}
	const fetcher = options.fetch ?? defaultFetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	let response: ModelsEndpointResponse;
	try {
		response = await fetcher(url, { method: "GET", headers, signal: controller.signal });
	} catch (error) {
		const reason = isAbortError(error) ? `timed out after ${timeoutMs}ms` : stringifyError(error);
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint request failed: ${reason}`);
	} finally {
		clearTimeout(timeout);
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
}

function buildModelsEndpointUrl(baseUrl: string, endpoint = DEFAULT_MODELS_ENDPOINT): string {
	return new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function buildModelsEndpointHeaders(providerId: string, provider: ProviderConfig, env: Record<string, string> | undefined): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	const customHeaders = resolveHeadersOrThrow(provider.advanced?.headers, `provider "${providerId}" models endpoint`, env);
	if (customHeaders) Object.assign(headers, customHeaders);
	if (hasAuthHeader(headers)) return headers;

	const apiKeyConfig = provider.api_key && provider.api_key.length > 0 ? provider.api_key : defaultApiKeyConfig(providerId);
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
		if (seen.has(model.model)) continue;
		seen.add(model.model);
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
	if (typeof entry === "string" && entry.trim().length > 0) return { model: entry };
	if (!isRecord(entry)) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint data[${index}] must be an object or non-empty string`);
	}

	const id = firstString(entry, ["id", "model"]);
	if (!id) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint data[${index}].id is required`);
	}

	const model: ModelConfig = { model: id };
	const displayName = firstString(entry, ["display_name", "name"]);
	if (displayName && displayName !== id) model.display_name = displayName;
	const contextWindow = firstPositiveNumber(entry, ["context_window", "context_length", "max_context_length", "max_model_len", "max_sequence_length"]);
	if (contextWindow !== undefined) model.context_window = contextWindow;
	const maxTokens = firstPositiveNumber(entry, ["max_output_tokens", "max_completion_tokens"])
		?? firstPositiveNumber(nestedRecord(entry, "top_provider"), ["max_completion_tokens", "max_output_tokens"]);
	if (maxTokens !== undefined) model.max_tokens = maxTokens;
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
