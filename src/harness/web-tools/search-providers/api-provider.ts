import type { Dispatcher } from "undici";

import { classifyNetworkError } from "../network/errors.ts";
import { readLimitedResponseBody } from "../network/response-body.ts";
import type { WebHttpFetch, WebHttpResponse } from "../network/types.ts";
import type { SearchProviderConfig } from "../config-types.ts";
import { filteredLexicalQuery } from "./query.ts";
import { classifyHttpStatus, normalizeProviderResponse, searchFailure } from "./response.ts";
import type { NormalizedSearchParams, ResolvedApiProvider, SearchProviderContext, SearchProviderFailure, SearchProviderResult } from "./types.ts";

type ApiProviderOptions = ResolvedApiProvider & {
	dispatcher: () => Promise<Dispatcher>;
	fetchImpl: WebHttpFetch;
};

interface ProviderRequest {
	url: URL;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
}

type ProviderHttpResult = { status: "success"; httpStatus: number; bytes: Uint8Array } | SearchProviderFailure;

/** 配置和已解析凭据属于本次请求，提供方不保留会话状态。 */
export async function searchApiProvider(options: ApiProviderOptions, params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult> {
	const remaining = context.deadlineAt - context.now();
	if (remaining <= 0) return searchFailure("TIMEOUT", "websearch deadline exceeded.");
	const timeout = AbortSignal.timeout(Math.min(options.config.timeout_seconds * 1000, remaining));
	const signal = AbortSignal.any([context.signal, timeout]);
	context.onUpdate?.({ content: "Searching...", details: { status: "progress", phase: "requesting" } });
	let response = await send(buildProviderRequest(options, params));
	if (response.status === "success" && options.id === "anysearch" && options.key !== undefined
		&& (response.httpStatus === 401 || response.httpStatus === 402 || response.httpStatus === 403)) {
		// 匿名重试沿用首次请求的超时预算，取消后不会发送。
		response = await send(buildAnySearchRequest(options.config, params, undefined));
	}
	if (response.status === "failed") return response;
	const text = new TextDecoder().decode(response.bytes);
	if (response.httpStatus < 200 || response.httpStatus >= 300) {
		const error = classifyHttpStatus(response.httpStatus, text);
		return searchFailure(error.code, error.message, response.httpStatus);
	}
	context.onUpdate?.({ content: "Parsing results...", details: { status: "progress", phase: "parsing" } });
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return searchFailure("PARSE_FAILED", `${options.id} returned invalid JSON.`, response.httpStatus);
	}
	return normalizeProviderResponse(options.id, parsed, response.bytes.length);

	async function send(request: ProviderRequest): Promise<ProviderHttpResult> {
		let response: WebHttpResponse;
		try {
			signal.throwIfAborted();
			response = await options.fetchImpl(request.url, {
				method: request.method, redirect: "manual", dispatcher: await options.dispatcher(), signal,
				headers: request.headers,
				...(request.body === undefined ? {} : { body: request.body }),
			});
		} catch (error) {
			const networkCode = context.userSignal?.aborted ? "ABORTED" : signal.aborted ? "TIMEOUT" : classifyNetworkError(error);
			const code = networkCode === "BLOCKED_ADDRESS" ? "CONNECTION_FAILED" : networkCode;
			return searchFailure(code, sanitizeError(error, options.key));
		}
		const body = await readLimitedResponseBody(response, {
			maxBytes: options.config.response_bytes, signal,
			onProgress(receivedBytes) {
				context.onUpdate?.({ content: `Downloading ${receivedBytes} bytes...`, details: { status: "progress", phase: "downloading", received_bytes: receivedBytes } });
			},
		});
		if (body.status === "failed") {
			const code = body.code === "ABORTED" && !context.userSignal?.aborted ? "TIMEOUT" : body.code;
			return searchFailure(code, body.message, response.status);
		}
		return { status: "success", httpStatus: response.status, bytes: body.bytes };
	}
}

function buildProviderRequest(provider: ResolvedApiProvider, params: NormalizedSearchParams): ProviderRequest {
	switch (provider.id) {
		case "brave_api": return buildBraveRequest(provider.config, params, provider.key);
		case "exa_api": return buildExaRequest(provider.config, params, provider.key);
		case "tavily": return buildTavilyRequest(provider.config, params, provider.key);
		case "tinyfish": return buildTinyfishRequest(provider.config, params, provider.key);
		case "anysearch": return buildAnySearchRequest(provider.config, params, provider.key);
	}
}

function buildBraveRequest(config: SearchProviderConfig, params: NormalizedSearchParams, key: string): ProviderRequest {
	const url = new URL(config.endpoint);
	url.searchParams.set("q", filteredLexicalQuery(params));
	url.searchParams.set("count", String(params.limit));
	url.searchParams.set("maximum_number_of_urls", String(params.limit));
	url.searchParams.set("safesearch", "moderate");
	return { url, method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } };
}

function buildExaRequest(config: SearchProviderConfig, params: NormalizedSearchParams, key: string): ProviderRequest {
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

function buildTavilyRequest(config: SearchProviderConfig, params: NormalizedSearchParams, key: string): ProviderRequest {
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

function buildTinyfishRequest(config: SearchProviderConfig, params: NormalizedSearchParams, key: string): ProviderRequest {
	const url = new URL(config.endpoint);
	url.searchParams.set("query", params.textQuery);
	if (params.includeDomains.length > 0) url.searchParams.set("include_domains", params.includeDomains.join(","));
	if (params.excludeDomains.length > 0) url.searchParams.set("exclude_domains", params.excludeDomains.join(","));
	return { url, method: "GET", headers: { Accept: "application/json", "X-API-Key": key } };
}

function buildAnySearchRequest(config: SearchProviderConfig, params: NormalizedSearchParams, key: string | undefined): ProviderRequest {
	return {
		url: new URL(config.endpoint), method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }) },
		body: JSON.stringify({ query: filteredLexicalQuery(params), max_results: params.limit, format: "json" }),
	};
}

function sanitizeError(error: unknown, key: string | undefined): string {
	const message = error instanceof Error ? error.message : String(error);
	return key === undefined ? message : message.split(key).join("REDACTED");
}
