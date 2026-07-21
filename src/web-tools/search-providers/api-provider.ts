import type { Dispatcher } from "undici";
import type { RegularSearchOptions } from "exa-js";
import type { TavilySearchOptions } from "@tavily/core";

import { classifyNetworkError } from "../http-client.js";
import { readLimitedResponseBody } from "../response-body.js";
import type { FormalWebSearchProviderId, WebHttpFetch, WebSearchErrorCode, WebSearchFailureDetails, WebSearchItem, WebToolsConfig } from "../types.js";
import { normalizeSearchResultUrl, normalizeSearchText, SEARCH_RESULT_MAX_SNIPPET_CHARS, SEARCH_RESULT_MAX_TITLE_CHARS } from "../url-utils.js";
import { resolveSearchApiKey } from "./api-key.js";
import { filteredLexicalQuery } from "./query.js";
import type { NormalizedSearchParams, SearchProviderResult, WebSearchProvider } from "./types.js";

type ApiProviderConfig = WebToolsConfig["websearch"][FormalWebSearchProviderId];

export interface ApiProviderOptions {
	id: FormalWebSearchProviderId;
	config: ApiProviderConfig;
	dispatcher: Dispatcher | (() => Promise<Dispatcher>);
	fetchImpl: WebHttpFetch;
}

export interface ProviderRequest {
	url: URL;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
}

export function createApiSearchProvider(options: ApiProviderOptions): WebSearchProvider {
	return {
		id: options.id,
		configured: () => options.config.enabled && resolveSearchApiKey(options.config.api_key) !== undefined,
		async search(params, context) {
			if (!options.config.enabled) return { status: "skipped", provider: options.id, reason: "provider disabled" };
			const key = resolveSearchApiKey(options.config.api_key);
			if (key === undefined) return { status: "skipped", provider: options.id, reason: "API key is not configured" };
			const remaining = (context.deadlineAt ?? Number.POSITIVE_INFINITY) - context.now();
			if (remaining <= 0) return failed(options.id, "TIMEOUT", "websearch deadline exceeded.", params.query);
			const timeout = AbortSignal.timeout(Math.min(options.config.timeout_seconds * 1000, remaining));
			const signal = AbortSignal.any([context.signal ?? new AbortController().signal, timeout]);
			const request = buildProviderRequest(options.id, options.config, params, key);
			context.onUpdate?.({ content: "Searching...", details: { status: "progress", phase: "requesting" } });
			try {
				const response = await options.fetchImpl(request.url, {
					method: request.method,
					redirect: "manual",
					dispatcher: await resolveDispatcher(options.dispatcher),
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

export function buildProviderRequest(id: FormalWebSearchProviderId, config: ApiProviderConfig, params: NormalizedSearchParams, key: string): ProviderRequest {
	if (id === "brave_api") return buildBraveRequest(config as WebToolsConfig["websearch"]["brave_api"], params, key);
	if (id === "exa_api") return buildExaRequest(config as WebToolsConfig["websearch"]["exa_api"], params, key);
	return buildTavilyRequest(config as WebToolsConfig["websearch"]["tavily"], params, key);
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
	const options: RegularSearchOptions = {
		type: "auto",
		numResults: Math.min(10, Math.max(params.limit, 6)),
		contents: { highlights: { maxCharacters: config.highlight_chars } },
		...(params.compiled.intent === "paper" ? { category: "research paper" } : {}),
		...(params.includeDomains.length > 0 ? { includeDomains: params.includeDomains } : {}),
		...(params.excludeDomains.length > 0 ? { excludeDomains: params.excludeDomains } : {}),
	};
	const body = { query: params.compiled.semanticQuery, ...options };
	return { url: new URL(config.endpoint), method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify(body) };
}

export function buildTavilyRequest(config: WebToolsConfig["websearch"]["tavily"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const complex = params.lastFormalOpportunity === true && (params.compiled.intent === "semantic" || params.compiled.intent === "paper");
	const options: TavilySearchOptions = {
		maxResults: Math.min(10, Math.max(params.limit, 5)), searchDepth: complex ? "advanced" : "basic", autoParameters: false,
		includeAnswer: false, includeRawContent: false, includeImages: false,
		...(params.includeDomains.length > 0 ? { includeDomains: params.includeDomains } : {}), ...(params.excludeDomains.length > 0 ? { excludeDomains: params.excludeDomains } : {}),
	};
	const body = {
		query: params.compiled.semanticQuery,
		max_results: options.maxResults, search_depth: options.searchDepth, auto_parameters: options.autoParameters,
		include_answer: options.includeAnswer, include_raw_content: options.includeRawContent, include_images: options.includeImages,
		...(options.includeDomains !== undefined ? { include_domains: options.includeDomains } : {}), ...(options.excludeDomains !== undefined ? { exclude_domains: options.excludeDomains } : {}),
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
	return { status: "success", provider: id, results, downloadedBytes, ...(typeof raw["requestId"] === "string" ? { requestId: raw["requestId"] } : {}) };
}

function normalizedItem(id: FormalWebSearchProviderId, row: Record<string, unknown>, rank: number): WebSearchItem | undefined {
	const rawUrl = string(row["url"]);
	const url = rawUrl === undefined ? undefined : normalizeSearchResultUrl(rawUrl)?.toString();
	if (url === undefined) return undefined;
	const title = normalizeSearchText(string(row["title"]) ?? url).slice(0, SEARCH_RESULT_MAX_TITLE_CHARS) || url;
	const highlights = array(row["highlights"]).filter((value): value is string => typeof value === "string").join(" ");
	const extra = array(row["extra_snippets"]).filter((value): value is string => typeof value === "string").join(" ");
	const snippet = normalizeSearchText((string(row[id === "tavily" ? "content" : "description"]) ?? highlights) || extra).slice(0, SEARCH_RESULT_MAX_SNIPPET_CHARS);
	const score = number(row["score"]) ?? array(row["highlightScores"]).find((value): value is number => typeof value === "number");
	return { rank, title, url, ...(snippet ? { snippet } : {}), ...(score !== undefined ? { score } : {}) };
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

function resolveDispatcher(value: Dispatcher | (() => Promise<Dispatcher>)): Promise<Dispatcher> { return typeof value === "function" ? value() : Promise.resolve(value); }
function parseJson(bytes: Uint8Array): unknown | undefined { try { return JSON.parse(decode(bytes)); } catch { return undefined; } }
function decode(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
function sanitizeError(error: unknown, key: string): string { return (error instanceof Error ? error.message : String(error)).split(key).join("REDACTED").slice(0, 300); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function nestedRows(value: Record<string, unknown>, key: string): unknown[] { const nested = value[key]; return record(nested) ? array(nested["results"]) : []; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function retryAfterMs(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function userAborted(context: { signal?: AbortSignal; userSignal?: AbortSignal; deadlineAt?: number }): boolean { return context.userSignal?.aborted === true || context.deadlineAt === undefined && context.signal?.aborted === true; }
