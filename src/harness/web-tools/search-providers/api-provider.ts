import type { Dispatcher } from "undici";

import { classifyNetworkError } from "../network/errors.ts";
import { readLimitedResponseBody } from "../network/response-body.ts";
import type { WebSearchProviderId, WebSearchErrorCode, WebSearchFailureDetails, WebSearchItem } from "../core/types.ts";
import type { WebHttpFetch } from "../network/types.ts";
import type { WebToolsConfig } from "../config-types.ts";
import { normalizeSearchResultUrl, normalizeSearchText, stripTerminalControls } from "../network/url-utils.ts";
import { filteredLexicalQuery } from "./query.ts";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult } from "./types.ts";

type ApiProviderId = Exclude<WebSearchProviderId, "exa_mcp">;
type ProviderConfig = {
	[Id in ApiProviderId]: { id: Id; config: WebToolsConfig["websearch"][Id]; key: Id extends "anysearch" ? string | undefined : string };
}[ApiProviderId];

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

/** 配置和已解析凭据属于本次请求，提供方不保留会话状态。 */
export async function searchApiProvider(options: ApiProviderOptions, params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult> {
	const remaining = (context.deadlineAt ?? Number.POSITIVE_INFINITY) - context.now();
	if (remaining <= 0) return failed(options.id, "TIMEOUT", "websearch deadline exceeded.", params.query);
	const timeout = AbortSignal.timeout(Math.min(options.config.timeout_seconds * 1000, remaining));
	const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
	let request = buildProviderRequest(options, params);
	let authenticated = options.id === "anysearch" && options.key !== undefined;
	context.onUpdate?.({ content: "Searching...", details: { status: "progress", phase: "requesting" } });
	try {
		for (;;) {
			signal.throwIfAborted();
			const response = await options.fetchImpl(request.url, {
				method: request.method, redirect: "manual", dispatcher: await options.dispatcher(), signal,
				headers: request.headers,
				...(request.body === undefined ? {} : { body: request.body }),
			});
			const body = await readLimitedResponseBody(response, {
				maxBytes: options.config.response_bytes, signal,
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
				if (options.id === "anysearch" && authenticated && (response.status === 401 || response.status === 402 || response.status === 403)) {
					request = buildAnySearchRequest(options.config, params, undefined);
					authenticated = false;
					continue;
				}
				return failed(options.id, classified.code, classified.message, params.query, response.status, retryAfterMs(response.headers.get("retry-after"), context.now()));
			}
			context.onUpdate?.({ content: "Parsing results...", details: { status: "progress", phase: "parsing" } });
			const parsed = parseJson(body.bytes);
			if (parsed === undefined) return failed(options.id, "PARSE_FAILED", `${options.id} returned invalid JSON.`, params.query, response.status);
			return normalizeProviderResponse(options.id, parsed, params, body.bytes.length);
		}
	} catch (error) {
		const networkCode = userAborted(context) ? "ABORTED" : signal.aborted ? "TIMEOUT" : classifyNetworkError(error, context.userSignal ?? (context.deadlineAt === undefined ? context.signal : undefined));
		const code = networkCode === "BLOCKED_ADDRESS" ? "CONNECTION_FAILED" : networkCode;
		return failed(options.id, code, sanitizeError(error, options.key), params.query);
	}
}

function buildProviderRequest(provider: ProviderConfig, params: NormalizedSearchParams): ProviderRequest {
	switch (provider.id) {
		case "brave_api": return buildBraveRequest(provider.config, params, provider.key);
		case "exa_api": return buildExaRequest(provider.config, params, provider.key);
		case "tavily": return buildTavilyRequest(provider.config, params, provider.key);
		case "tinyfish": return buildTinyfishRequest(provider.config, params, provider.key);
		case "anysearch": return buildAnySearchRequest(provider.config, params, provider.key);
	}
}

export function buildBraveRequest(config: WebToolsConfig["websearch"]["brave_api"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const url = new URL(config.endpoint);
	url.searchParams.set("q", filteredLexicalQuery(params));
	url.searchParams.set("count", String(params.limit));
	url.searchParams.set("maximum_number_of_urls", String(params.limit));
	url.searchParams.set("safesearch", "moderate");
	return { url, method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } };
}

export function buildExaRequest(config: WebToolsConfig["websearch"]["exa_api"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const { textQuery, includeDomains, excludeDomains } = params;
	const body = {
		query: textQuery,
		type: "auto",
		numResults: params.limit,
		contents: { highlights: { dynamic: true } },
		...(includeDomains.length > 0 ? { includeDomains } : {}),
		...(excludeDomains.length > 0 ? { excludeDomains } : {}),
	};
	return { url: new URL(config.endpoint), method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": key, "Exa-Beta": "dynamic-highlights-2026-08-28" }, body: JSON.stringify(body) };
}

export function buildTavilyRequest(config: WebToolsConfig["websearch"]["tavily"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const { textQuery, includeDomains, excludeDomains } = params;
	const body = {
		query: textQuery,
		max_results: params.limit,
		search_depth: "basic",
		auto_parameters: false,
		include_answer: false,
		include_raw_content: false,
		include_images: false,
		...(includeDomains.length > 0 ? { include_domains: includeDomains } : {}),
		...(excludeDomains.length > 0 ? { exclude_domains: excludeDomains } : {}),
	};
	return { url: new URL(config.endpoint), method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) };
}

export function buildTinyfishRequest(config: WebToolsConfig["websearch"]["tinyfish"], params: NormalizedSearchParams, key: string): ProviderRequest {
	const url = new URL(config.endpoint);
	url.searchParams.set("query", params.textQuery);
	if (params.includeDomains.length > 0) url.searchParams.set("include_domains", params.includeDomains.join(","));
	if (params.excludeDomains.length > 0) url.searchParams.set("exclude_domains", params.excludeDomains.join(","));
	return { url, method: "GET", headers: { Accept: "application/json", "X-API-Key": key } };
}

export function buildAnySearchRequest(config: WebToolsConfig["websearch"]["anysearch"], params: NormalizedSearchParams, key: string | undefined): ProviderRequest {
	return {
		url: new URL(config.endpoint), method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }) },
		body: JSON.stringify({ query: filteredLexicalQuery(params), max_results: params.limit, format: "json" }),
	};
}

export function normalizeProviderResponse(id: WebSearchProviderId, raw: unknown, params: NormalizedSearchParams, downloadedBytes: number): SearchProviderResult {
	const { query } = params;
	if (!record(raw)) return failed(id, "PARSE_FAILED", `${id} response is not an object.`, query);
	if (id === "anysearch" && (raw["code"] !== 0 || !record(raw["data"]) || !Array.isArray(raw["data"]["results"]))) {
		return failed(id, "PARSE_FAILED", "anysearch returned an invalid search response.", query);
	}
	const rows = id === "brave_api" ? braveRows(raw) : id === "anysearch" ? nestedRows(raw, "data") : array(raw["results"]);
	const results: WebSearchItem[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (!record(row)) continue;
		const normalized = normalizedItem(id, row, results.length + 1);
		if (normalized === undefined || seen.has(normalized.url)) continue;
		seen.add(normalized.url);
		results.push(normalized);
	}
	return { status: "success", provider: id, results, downloadedBytes };
}

function normalizedItem(id: WebSearchProviderId, row: Record<string, unknown>, rank: number): WebSearchItem | undefined {
	const rawUrl = string(row["url"]);
	const url = rawUrl === undefined ? undefined : normalizeSearchResultUrl(rawUrl)?.toString();
	if (url === undefined) return undefined;
	const title = normalizeSearchText(string(row["title"]) ?? url) || url;
	const candidates = id === "brave_api" ? array(row["snippets"])
		: id === "anysearch" ? [row["content"], row["snippet"]]
		: [row[id === "tavily" ? "content" : id === "tinyfish" ? "snippet" : "description"], ...array(row["highlights"]), ...(id === "exa_mcp" ? [row["text"]] : [])];
	// 保留全部非空片段及代码排版，只清理终端控制字符和完全重复的片段。
	const snippets = candidates.filter((value): value is string => typeof value === "string")
		.map((value) => stripTerminalControls(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""))
		.filter((value) => value.trim().length > 0);
	const snippet = [...new Set(snippets)].join("\n\n");
	return { rank, title, url, ...(snippet ? { snippet } : {}) };
}

export function classifyHttpStatus(status: number, body: string): { code: WebSearchErrorCode; message: string } {
	const lower = body.toLowerCase();
	if (status === 429) return { code: "RATE_LIMITED", message: "search provider rate limit exceeded." };
	if (status === 402 || lower.includes("quota") || lower.includes("credit") && lower.includes("exhaust")) return { code: "QUOTA_EXHAUSTED", message: "search provider quota exhausted." };
	if (status === 401 || status === 403) return { code: "CONFIG_ERROR", message: `search provider rejected credentials (${status}).` };
	if (status === 400 || status === 422) return { code: "INVALID_ARGUMENT", message: `search provider rejected the search request (${status}).` };
	if (status >= 300 && status < 400 || status === 404 || status === 405) return { code: "CONFIG_ERROR", message: `search provider endpoint is misconfigured (${status}).` };
	return { code: "HTTP_ERROR", message: `${status} search provider HTTP error.` };
}

function failed(provider: WebSearchProviderId, code: WebSearchErrorCode, message: string, query: string, httpStatus?: number, retryAfter?: number): SearchProviderResult {
	const details: WebSearchFailureDetails = { status: "failed", provider, query, error: { code, message }, ...(httpStatus !== undefined ? { http_status: httpStatus } : {}), ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}) };
	return { status: "failed", provider, details };
}

function parseJson(bytes: Uint8Array): unknown | undefined { try { return JSON.parse(decode(bytes)); } catch { return undefined; } }
function decode(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
function sanitizeError(error: unknown, key: string | undefined): string {
	const message = error instanceof Error ? error.message : String(error);
	return key === undefined ? message : message.split(key).join("REDACTED");
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function nestedRows(value: Record<string, unknown>, key: string): unknown[] { const nested = value[key]; return record(nested) ? array(nested["results"]) : []; }
function braveRows(raw: Record<string, unknown>): unknown[] {
	const grounding = raw["grounding"];
	if (!record(grounding)) return [];
	return [...array(grounding["generic"]), ...(record(grounding["poi"]) ? [grounding["poi"]] : []), ...array(grounding["map"])];
}
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
