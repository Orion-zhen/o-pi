import type { Dispatcher } from "undici";
import type { SearchRequestGate } from "../search/search-request-gate.js";
import type { WebSearchFailureDetails } from "../core/types.js";
import type { WebHttpFetch } from "../network/types.js";
import type { WebToolsConfig } from "../config-types.js";
import { filteredLexicalQuery } from "./query.js";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult } from "./types.js";

export interface DuckDuckGoHtmlProviderOptions {
	config: WebToolsConfig["websearch"]["duckduckgo_html"];
	dispatcher: () => Promise<Dispatcher>;
	fetchImpl: WebHttpFetch;
	requestGate: SearchRequestGate;
}

/** DDG 请求共用会话节流器，配置和回调只属于本次请求。 */
export async function searchDuckDuckGoProvider(options: DuckDuckGoHtmlProviderOptions, params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult> {
	const backendPromise = import("../search/duckduckgo-html.js");
	void backendPromise.catch(() => undefined);
	const gate = await options.requestGate.beforeRequest(context.signal, (waitMs) => {
		context.onUpdate?.({
			content: `Waiting ${formatSeconds(waitMs)} before searching...`,
			details: { status: "progress", phase: "waiting", wait_ms: waitMs },
		});
	});
	if (gate.status === "blocked") {
		return failed("PROVIDER_BLOCKED", `DuckDuckGo recently blocked automated search requests. Retry after about ${formatSeconds(gate.retryAfterMs)}.`, params.query);
	}
	if (gate.status === "aborted") return failed(userAborted(context) ? "ABORTED" : "TIMEOUT", gate.message, params.query);
	const remaining = (context.deadlineAt ?? Number.POSITIVE_INFINITY) - context.now();
	if (remaining <= 0) return failed("TIMEOUT", "websearch deadline exceeded.", params.query);
	const timeout = AbortSignal.timeout(Math.min(options.config.timeout_seconds * 1000, remaining));
	const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
	const [{ searchDuckDuckGoHtml }, dispatcher] = await Promise.all([backendPromise, options.dispatcher()]);
	const userSignal = context.userSignal ?? (context.deadlineAt === undefined ? context.signal : undefined);
	const result = await searchDuckDuckGoHtml({
		query: filteredLexicalQuery(params), limit: params.limit, config: options.config,
		dispatcher, fetchImpl: options.fetchImpl, signal,
		...(userSignal === undefined ? {} : { userSignal }),
		onDownloading(receivedBytes, expectedBytes) {
			context.onUpdate?.({
				content: `Downloading ${receivedBytes} bytes...`,
				details: {
					status: "progress", phase: "downloading", received_bytes: receivedBytes,
					...(expectedBytes === undefined ? {} : { expected_bytes: expectedBytes }),
				},
			});
		},
		onParsing() {
			context.onUpdate?.({ content: "Parsing results...", details: { status: "progress", phase: "parsing" } });
		},
	});
	if (result.status === "failed") {
		if (result.details.error.code === "PROVIDER_BLOCKED") options.requestGate.markProviderBlocked();
		const expired = context.signal?.aborted && !userAborted(context);
		const details = expired && (result.details.error.code === "ABORTED" || result.details.error.code === "CONNECTION_FAILED")
			? { ...result.details, error: { code: "TIMEOUT" as const, message: result.details.error.message } }
			: result.details;
		return { status: "failed", provider: "duckduckgo_html", details };
	}
	return { status: "success", provider: "duckduckgo_html", results: result.results, downloadedBytes: result.downloadedBytes };
}

function failed(code: WebSearchFailureDetails["error"]["code"], message: string, query: string): SearchProviderResult {
	return {
		status: "failed", provider: "duckduckgo_html",
		details: { status: "failed", error: { code, message }, query, provider: "duckduckgo_html" },
	};
}

function formatSeconds(ms: number): string {
	return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

function userAborted(context: SearchProviderContext): boolean {
	return context.userSignal?.aborted === true || context.deadlineAt === undefined && context.signal?.aborted === true;
}
