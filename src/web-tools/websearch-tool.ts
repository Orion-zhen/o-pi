import type { Dispatcher } from "undici";

import { searchDuckDuckGoHtml } from "./duckduckgo-html.js";
import type { SearchCache } from "./search-cache.js";
import { searchCacheKey } from "./search-cache.js";
import type { SearchRequestGate } from "./search-request-gate.js";
import type { WebHttpFetch, WebSearchExecutionContext, WebSearchFailureDetails, WebSearchParams, WebSearchResult, WebSearchSuccessDetails, WebToolsConfig } from "./types.js";
import { escapeXml } from "./url-utils.js";

const SEARCH_RECENCIES = new Set(["day", "week", "month", "year"]);

/** 搜索执行层依赖；保持 DDG 后端、缓存和 Pi context 可替换以便测试。 */
export interface ExecuteWebSearchRuntime {
	dispatcher: Dispatcher;
	fetchImpl: WebHttpFetch;
	config: WebToolsConfig;
	searches: SearchCache;
	requestGate: SearchRequestGate;
	context: WebSearchExecutionContext;
	now: () => number;
}

/** 执行公开网页搜索；只返回搜索结果，不抓取结果页面。 */
export async function executeWebSearch(params: WebSearchParams, runtime: ExecuteWebSearchRuntime): Promise<WebSearchResult> {
	const startedAt = runtime.now();
	const validation = validateParams(params);
	if (validation !== undefined) return { content: failureContent(validation), details: { ...validation, duration_ms: runtime.now() - startedAt } };

	const query = params.query.trim();
	const limit = params.limit ?? runtime.config.websearch.default_results;
	const key = searchCacheKey(query, params.recency, runtime.config.websearch.region, limit);
	const cached = runtime.searches.get(key);
	if (cached !== undefined) {
		const details: WebSearchSuccessDetails = {
			status: "success",
			query,
			provider: "duckduckgo_html",
			results: cached.results,
			cached: true,
			downloaded_bytes: cached.downloadedBytes,
			duration_ms: runtime.now() - startedAt,
		};
		return { content: successContent(details), details };
	}

	runtime.context.onUpdate?.({
		content: "Searching...",
		details: { status: "progress", phase: "requesting" },
	});
	const gate = await runtime.requestGate.beforeRequest(runtime.context.signal, (waitMs) => {
		runtime.context.onUpdate?.({
			content: `Waiting ${formatSeconds(waitMs)} before searching...`,
			details: { status: "progress", phase: "waiting", wait_ms: waitMs },
		});
	});
	if (gate.status === "blocked") {
		const details: WebSearchFailureDetails = {
			status: "failed",
			error: {
				code: "PROVIDER_BLOCKED",
				message: `DuckDuckGo recently blocked automated search requests. Retry after about ${formatSeconds(gate.retryAfterMs)}.`,
			},
			query,
			provider: "duckduckgo_html",
			duration_ms: runtime.now() - startedAt,
		};
		return { content: failureContent(details), details };
	}
	if (gate.status === "aborted") {
		const details: WebSearchFailureDetails = {
			status: "failed",
			error: { code: "ABORTED", message: gate.message },
			query,
			provider: "duckduckgo_html",
			duration_ms: runtime.now() - startedAt,
		};
		return { content: failureContent(details), details };
	}
	const timeoutSignal = AbortSignal.timeout(runtime.config.websearch.timeout_seconds * 1000);
	const signal = AbortSignal.any([runtime.context.signal ?? new AbortController().signal, timeoutSignal]);
	const result = await searchDuckDuckGoHtml({
		query,
		limit,
		...(params.recency !== undefined ? { recency: params.recency } : {}),
		config: runtime.config.websearch,
		dispatcher: runtime.dispatcher,
		fetchImpl: runtime.fetchImpl,
		signal,
		...(runtime.context.signal !== undefined ? { userSignal: runtime.context.signal } : {}),
		onDownloading(receivedBytes, expectedBytes) {
			runtime.context.onUpdate?.({
				content: `Downloading ${receivedBytes} bytes...`,
				details: {
					status: "progress",
					phase: "downloading",
					received_bytes: receivedBytes,
					...(expectedBytes !== undefined ? { expected_bytes: expectedBytes } : {}),
				},
			});
		},
		onParsing() {
			runtime.context.onUpdate?.({
				content: "Parsing results...",
				details: { status: "progress", phase: "parsing" },
			});
		},
	});

	if (result.status === "failed") {
		if (result.details.error.code === "PROVIDER_BLOCKED") runtime.requestGate.markProviderBlocked();
		const details = {
			...result.details,
			duration_ms: runtime.now() - startedAt,
		};
		return { content: failureContent(details), details };
	}

	const details: WebSearchSuccessDetails = {
		status: "success",
		query,
		provider: "duckduckgo_html",
		results: result.results,
		cached: false,
		downloaded_bytes: result.downloadedBytes,
		duration_ms: runtime.now() - startedAt,
	};
	runtime.searches.set({
		key,
		createdAt: runtime.now(),
		results: result.results,
		downloadedBytes: result.downloadedBytes,
	});
	return { content: successContent(details), details };
}

function validateParams(params: WebSearchParams): WebSearchFailureDetails | undefined {
	if (!isRecord(params)) {
		return invalid("params must be an object.");
	}
	if (typeof params.query !== "string") {
		return invalid("query must be a string.");
	}
	const query = params.query.trim();
	if (query.length < 1 || query.length > 512) {
		return invalid("query length must be between 1 and 512 characters.");
	}
	if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 20)) {
		return invalid("limit must be an integer between 1 and 20.");
	}
	if (params.recency !== undefined && !SEARCH_RECENCIES.has(params.recency)) {
		return invalid("recency must be day, week, month, or year.");
	}
	return undefined;
}

function invalid(message: string): WebSearchFailureDetails {
	return {
		status: "failed",
		error: { code: "INVALID_ARGUMENT", message },
		provider: "duckduckgo_html",
	};
}

function successContent(details: WebSearchSuccessDetails): string {
	const attrs = [
		`query="${escapeXml(details.query)}"`,
		`count="${details.results.length}"`,
		`trust="untrusted"`,
	].join(" ");
	const body = details.results
		.map((item) => {
			const lines = [
				`[${item.rank}] ${escapeXml(truncateChars(item.title, 160))}`,
				`URL: ${escapeXml(item.url)}`,
				item.snippet ? `Snippet: ${escapeXml(truncateChars(item.snippet, 240))}` : undefined,
			].filter((line): line is string => line !== undefined);
			return lines.join("\n");
		})
		.join("\n\n");
	return `<websearch_results ${attrs}>\n${body}\n</websearch_results>`;
}

function failureContent(details: WebSearchFailureDetails): string {
	const content = {
		status: "failed",
		error: details.error,
		...(details.http_status !== undefined ? { http_status: details.http_status } : {}),
	};
	return JSON.stringify(content, null, 2);
}

function truncateChars(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function formatSeconds(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000));
	return `${seconds}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
