import type { ApiKeyCredential } from "@earendil-works/pi-ai";

import { resolveHeadersOrThrow } from "./config-values.ts";
import { invalidModelsConfig } from "./errors.ts";
import type { DiscoveredModel } from "./models.ts";
import type { ProviderConfig } from "./schema.ts";

const DEFAULT_MODELS_ENDPOINT = "models";
const DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 500;

export async function fetchProviderModelsFromEndpoint(
	providerId: string,
	provider: ProviderConfig,
	configPath: string,
	credential: ApiKeyCredential,
	signal: AbortSignal,
	baseUrl = provider.baseUrl,
): Promise<DiscoveredModel[]> {
	let url: string;
	try {
		url = new URL(provider.modelsEndpoint ?? DEFAULT_MODELS_ENDPOINT, ensureTrailingSlash(baseUrl)).toString();
	} catch (error) {
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint configuration failed: ${stringifyError(error)}`);
	}
	const headers = resolveRefreshHeaders(providerId, provider, credential);
	const timeout = AbortSignal.timeout(DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS);
	const requestSignal = AbortSignal.any([signal, timeout]);
	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers, signal: requestSignal });
	} catch (error) {
		const reason = requestSignal.aborted
			? (requestSignal.reason === timeout.reason ? `timed out after ${DEFAULT_MODELS_ENDPOINT_TIMEOUT_MS}ms` : "cancelled")
			: stringifyError(error);
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint request failed: ${reason}`);
	}

	let responseText: string;
	try {
		responseText = await response.text();
	} catch (error) {
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint response cannot be read: ${stringifyError(error)}`);
	}
	if (!response.ok) {
		throw invalidModelsConfig(
			configPath,
			`provider "${providerId}" models endpoint returned HTTP ${response.status}${formatStatusText(response.statusText)}${formatErrorBody(responseText)}`,
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint did not return valid JSON`);
	}
	return parseModelsEndpointPayload(payload, configPath, providerId);
}

/** SDK 刷新上下文只携带 key/env，目录请求单独解析原生 provider 请求头。 */
function resolveRefreshHeaders(providerId: string, provider: ProviderConfig, credential: ApiKeyCredential): Headers {
	const headers = new Headers(resolveHeadersOrThrow(provider.headers, `provider "${providerId}"`, credential.env));
	if (!headers.has("Accept")) headers.set("Accept", "application/json");
	if (credential.key !== undefined && (provider.authHeader || !headers.has("Authorization"))) headers.set("Authorization", `Bearer ${credential.key}`);
	return headers;
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function parseModelsEndpointPayload(payload: unknown, configPath: string, providerId: string): DiscoveredModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint JSON must be an object containing a data array`);
	}
	if (payload.data.length === 0) {
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint returned no models`);
	}
	return payload.data.map((entry, index) => parseModelEntry(entry, configPath, providerId, index));
}

function parseModelEntry(entry: unknown, configPath: string, providerId: string, index: number): DiscoveredModel {
	if (!isRecord(entry)) {
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint data[${index}] must be an object`);
	}
	const id = entry.id;
	if (typeof id !== "string" || id.trim().length === 0) {
		throw invalidModelsConfig(configPath, `provider "${providerId}" models endpoint data[${index}].id is required`);
	}

	const model: DiscoveredModel = { id };
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
