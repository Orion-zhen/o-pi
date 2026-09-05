import type { Dispatcher } from "undici";

import { classifyNetworkError } from "../network/errors.js";
import { readLimitedResponseBody } from "../network/response-body.js";
import type { FormalWebSearchProviderId, WebHttpFetch, WebSearchErrorCode, WebSearchFailureDetails, WebSearchItem, WebToolsConfig } from "../core/types.js";
import { normalizeSearchResultUrl, normalizeSearchText, SEARCH_RESULT_MAX_SNIPPET_CHARS, SEARCH_RESULT_MAX_TITLE_CHARS } from "../network/url-utils.js";
import { resolveSearchApiKey } from "./api-key.js";
import { filteredLexicalQuery } from "./query.js";
import type { NormalizedSearchParams, SearchProviderResult, WebSearchProvider } from "./types.js";

type ProviderConfig = {
	[Id in FormalWebSearchProviderId]: { id: Id; config: WebToolsConfig["websearch"][Id] };
}[FormalWebSearchProviderId];

export type ApiProviderOptions = ProviderConfig & {
	dispatcher: () => Promise<Dispatcher>;
	fetchImpl: WebHttpFetch;
};

export interface ProviderRequest {
	url: URL;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
}

export function createApiSearchProvider(options: ApiProviderOptions): WebSearchProvider {
	if (!options.config.enabled) throw new Error(`${options.id} provider is disabled.`);
	const key = resolveSearchApiKey(options.config.api_key);
	if (key === undefined) throw new Error(`${options.id} provider API key is unavailable.`);
	return {
		id: options.id,
		async search(params, context) {
			const remaining = (context.deadlineAt ?? Number.POSITIVE_INFINITY) - context.now();
			if (remaining <= 0) return failed(options.id, "TIMEOUT", "websearch deadline exceeded.", params.query);
			const timeout = AbortSignal.timeout(Math.min(options.config.timeout_seconds * 1000, remaining));
			const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
			const request = buildProviderRequest(options, params, key);
			context.onUpdate?.({ content: "Searching...", details: { status: "progress", phase: "requesting" } });
			try {
				const response = await options.fetchImpl(request.url, {
					method: request.method,
					redirect: "manual",
					dispatcher: await options.dispatcher(),
					signal,
					headers: request.headers,
					...(request.body !== undefined ? { body: request.body } : {}),
				});
				const body = await readLimitedResponseBody(response, {
					maxBytes: options.config.response_bytes,
					signal,
					onProgress(receivedBytes) {
						context.onUpdate?.({ content: `Downloading ${receivedBytes} bytes...`, details: { status: "progress", phase: "downloading", received_bytes: receivedBytes } });
					},
				});
				if (body.status === "failed") {
					const code = body.code === "ABORTED" && !userAborted(context) ? "TIMEOUT" : body.code;
					return failed(options.id, code, body.message, params.query, response.status);
				}
				if (response.status < 200 || response.status >= 300) {
					const classified = classifyHttpStatus(response.status, decode(body.bytes));
					return failed(options.id, classified.code, classified.message, params.query, response.status, retryAfterMs(response.headers.get("retry-after"), context.now()));
				}
				context.onUpdate?.({ content: "Parsing results...", details: { status: "progress", phase: "parsing" } });
				const parsed = parseJson(body.bytes);
				if (parsed === undefined) return failed(options.id, "PARSE_FAILED", `${options.id} returned invalid JSON.`, params.query, response.status);
				return normalizeProviderResponse(options.id, parsed, params.limit, body.bytes.length, params.query);
			} catch (error) {
				const networkCode = userAborted(context) ? "ABORTED" : signal.aborted ? "TIMEOUT" : classifyNetworkError(error, context.userSignal ?? (context.deadlineAt === undefined ? context.signal : undefined));
				const code = networkCode === "BLOCKED_ADDRESS" ? "CONNECTION_FAILED" : networkCode;
				return failed(options.id, code, sanitizeError(error, key), params.query);
			}
		},
	};
}

function buildProviderRequest(provider: ProviderConfig, params: NormalizedSearchParams, key: string): ProviderRequest {
	switch (provider.id) {
		case "brave_api": return buildBraveRequest(provider.config, params, key);
		case "exa_api": return buildExaRequest(provider.config, params, key);
		case "tavily": return buildTavilyRequest(provider.config, params, key);
	}
}

export function buildBraveRequest(config: WebToolsConfig["websearch"]["brave_api"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const url = new URL(config.endpoint);
	url.searchParams.set("q", filteredLexicalQuery(params));
	url.searchParams.set("count", String(Math.min(20, Math.max(params.limit, 8))));
	url.searchParams.set("text_decorations", "false");
	url.searchParams.set("safesearch", "moderate");
	url.searchParams.set("extra_snippets", String(config.extra_snippets));
	return { url, method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } };
}

export function buildExaRequest(config: WebToolsConfig["websearch"]["exa_api"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const { semanticQuery, intent, includeDomains, excludeDomains } = params.compiled;
	const body = {
		query: semanticQuery,
		type: "auto",
		numResults: Math.min(10, Math.max(params.limit, 6)),
		contents: { highlights: { maxCharacters: config.highlight_chars } },
		...(intent === "paper" ? { category: "publication" } : {}),
		...(includeDomains.length > 0 ? { includeDomains } : {}),
		...(excludeDomains.length > 0 ? { excludeDomains } : {}),
	};
	return { url: new URL(config.endpoint), method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify(body) };
}

export function buildTavilyRequest(config: WebToolsConfig["websearch"]["tavily"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const { semanticQuery, intent, includeDomains, excludeDomains } = params.compiled;
	const complex = params.lastFormalOpportunity === true && (intent === "semantic" || intent === "paper");
	const body = {
		query: semanticQuery,
		max_results: Math.min(10, Math.max(params.limit, 5)),
		search_depth: complex ? "advanced" : "basic",
		auto_parameters: false,
		include_answer: false,
		include_raw_content: false,
		include_images: false,
		...(includeDomains.length > 0 ? { include_domains: includeDomains } : {}),
		...(excludeDomains.length > 0 ? { exclude_domains: excludeDomains } : {}),
	};
	return { url: new URL(config.endpoint), method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) };
}

export function normalizeProviderResponse(id: FormalWebSearchProviderId, raw: unknown, limit: number, downloadedBytes = 0, query = ""): SearchProviderResult {
	if (!record(raw)) return failed(id, "PARSE_FAILED", `${id} response is not an object.`, query);
	const rows = id === "brave_api" ? nestedRows(raw, "web") : array(raw["results"]);
	const results: WebSearchItem[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (!record(row)) continue;
		const normalized = normalizedItem(id, row, results.length + 1);
		if (normalized === undefined || seen.has(normalized.url)) continue;
		seen.add(normalized.url);
		results.push(normalized);
		if (results.length >= limit) break;
	}
	return { status: "success", provider: id, results, downloadedBytes };
}

function normalizedItem(id: FormalWebSearchProviderId, row: Record<string, unknown>, rank: number): WebSearchItem | undefined {
	const rawUrl = string(row["url"]);
	const url = rawUrl === undefined ? undefined : normalizeSearchResultUrl(rawUrl)?.toString();
	if (url === undefined) return undefined;
	const title = normalizeSearchText(string(row["title"]) ?? url).slice(0, SEARCH_RESULT_MAX_TITLE_CHARS) || url;
	const highlights = array(row["highlights"]).filter((value): value is string => typeof value === "string").join(" ");
	const extra = array(row["extra_snippets"]).filter((value): value is string => typeof value === "string").join(" ");
	const snippet = normalizeSearchText((string(row[id === "tavily" ? "content" : "description"]) ?? highlights) || extra).slice(0, SEARCH_RESULT_MAX_SNIPPET_CHARS);
	return { rank, title, url, ...(snippet ? { snippet } : {}) };
}

function classifyHttpStatus(status: number, body: string): { code: WebSearchErrorCode; message: string } {
	const lower = body.toLowerCase();
	if (status === 429) return { code: "RATE_LIMITED", message: "search provider rate limit exceeded." };
	if (status === 402 || lower.includes("quota") || lower.includes("credit") && lower.includes("exhaust")) return { code: "QUOTA_EXHAUSTED", message: "search provider quota exhausted." };
	if (status === 401 || status === 403) return { code: "CONFIG_ERROR", message: `search provider rejected credentials (${status}).` };
	if (status === 400 || status === 422) return { code: "INVALID_ARGUMENT", message: `search provider rejected the search request (${status}).` };
	if (status >= 300 && status < 400 || status === 404 || status === 405) return { code: "CONFIG_ERROR", message: `search provider endpoint is misconfigured (${status}).` };
	return { code: "HTTP_ERROR", message: `${status} search provider HTTP error.` };
}

function failed(provider: FormalWebSearchProviderId, code: WebSearchErrorCode, message: string, query: string, httpStatus?: number, retryAfter?: number): SearchProviderResult {
	const details: WebSearchFailureDetails = { status: "failed", provider, query, error: { code, message }, ...(httpStatus !== undefined ? { http_status: httpStatus } : {}), ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}) };
	return { status: "failed", provider, details };
}

function parseJson(bytes: Uint8Array): unknown | undefined { try { return JSON.parse(decode(bytes)); } catch { return undefined; } }
function decode(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
function sanitizeError(error: unknown, key: string): string { return (error instanceof Error ? error.message : String(error)).split(key).join("REDACTED").slice(0, 300); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function nestedRows(value: Record<string, unknown>, key: string): unknown[] { const nested = value[key]; return record(nested) ? array(nested["results"]) : []; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }

function retryAfterMs(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function userAborted(context: { signal?: AbortSignal; userSignal?: AbortSignal; deadlineAt?: number }): boolean {
	return context.userSignal?.aborted === true || context.deadlineAt === undefined && context.signal?.aborted === true;
}
