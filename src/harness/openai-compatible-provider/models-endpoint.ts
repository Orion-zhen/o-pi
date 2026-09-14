import type { ApiKeyCredential } from "@earendil-works/pi-ai";

import { resolveRefreshAuth } from "./auth.ts";
import { invalidModelsJsonc } from "./errors.ts";
import type { ModelConfig, ProviderConfig } from "./schema.ts";

const DEFAULT_MODELS_ENDPOINT = "models";
const DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 500;

interface ModelsEndpointAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	keyless: boolean;
}

export async function fetchProviderModelsFromEndpoint(
	providerId: string,
	provider: ProviderConfig,
	configPath: string,
	credential: ApiKeyCredential,
	signal: AbortSignal,
): Promise<ModelConfig[]> {
	let url: string;
	try {
		url = modelsEndpointUrl(provider);
	} catch (error) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint configuration failed: ${stringifyError(error)}`);
	}
	const requestAuth = resolveRefreshAuth(providerId, credential);
	const headers = buildModelsEndpointHeaders(requestAuth);
	const timeout = AbortSignal.timeout(DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS);
	const requestSignal = AbortSignal.any([signal, timeout]);
	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers, signal: requestSignal });
	} catch (error) {
		const reason = requestSignal.aborted
			? (requestSignal.reason === timeout.reason ? `timed out after ${DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS}ms` : "cancelled")
			: stringifyError(error);
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint request failed: ${reason}`);
	}

	let responseText: string;
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

/** 以 endpoint 元数据为基底，手写模型按字段覆盖；保留手写顺序并追加远端独有模型。 */
export function mergeDiscoveredModelConfigs(
	configured: readonly ModelConfig[],
	discovered: readonly ModelConfig[],
): ModelConfig[] {
	const remaining = new Map(discovered.map((model) => [model.id, model]));
	const merged = configured.map((model) => {
		const remote = remaining.get(model.id);
		remaining.delete(model.id);
		return { ...remote, ...model };
	});
	return [...merged, ...remaining.values()];
}

function modelsEndpointUrl(provider: ProviderConfig): string {
	return new URL(provider.modelsEndpoint ?? DEFAULT_MODELS_ENDPOINT, ensureTrailingSlash(provider.baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function buildModelsEndpointHeaders(requestAuth: ModelsEndpointAuth): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (requestAuth.headers) Object.assign(headers, requestAuth.headers);
	if (!requestAuth.keyless && requestAuth.apiKey !== undefined && !hasAuthHeader(headers)) {
		headers.Authorization = `Bearer ${requestAuth.apiKey}`;
	}
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
	const ids = new Set<string>();
	const models = entries.map((entry, index) => {
		const model = parseModelEntry(entry, configPath, providerId, index);
		if (ids.has(model.id)) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" contains duplicate model "${model.id}"`);
		}
		ids.add(model.id);
		return model;
	});
	if (models.length === 0) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint returned no models`);
	}
	return models;
}

function extractModelEntries(payload: unknown, configPath: string, providerId: string): unknown[] {
	if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
	throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint JSON must be an object containing a data array`);
}

function parseModelEntry(entry: unknown, configPath: string, providerId: string, index: number): ModelConfig {
	if (!isRecord(entry)) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint data[${index}] must be an object`);
	}
	const id = entry.id;
	if (typeof id !== "string" || id.trim().length === 0) {
		throw invalidModelsJsonc(configPath, `provider "${providerId}" models endpoint data[${index}].id is required`);
	}

	const model: ModelConfig = { id };
	const contextWindow = entry.context_length;
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		model.contextWindow = contextWindow;
	}
	const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
	if (Array.isArray(architecture?.input_modalities) && architecture.input_modalities.includes("image")) {
		model.input = ["text", "image"];
	}
	return model;
}

function formatStatusText(value: string | undefined): string {
	return value && value.trim().length > 0 ? ` ${value}` : "";
}

function formatErrorBody(value: string): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (!trimmed) return "";
	const snippet = trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}...` : trimmed;
	return `: ${snippet}`;
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
