import type { Dispatcher } from "undici";

import type { SearchRequestGate } from "../search-request-gate.js";
import type { WebHttpFetch, WebSearchFailureDetails, WebToolsConfig } from "../types.js";
import { filteredLexicalQuery } from "./query.js";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.js";

export interface DuckDuckGoHtmlProviderOptions {
	config: WebToolsConfig["websearch"]["duckduckgo_html"];
	dispatcher: Dispatcher | (() => Promise<Dispatcher>);
	fetchImpl: WebHttpFetch;
	requestGate: SearchRequestGate;
}

/** 将既有 DDG HTML 后端包装成 provider；限流和 blocked 熔断只在此处生效。 */
export function createDuckDuckGoHtmlProvider(options: DuckDuckGoHtmlProviderOptions): WebSearchProvider {
	const backendPromise = options.config.enabled ? import("../duckduckgo-html.js") : undefined;
	void backendPromise?.catch(() => undefined);
	return {
		id: "duckduckgo_html",
		configured: () => options.config.enabled,
		async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult> {
			if (!options.config.enabled) return { status: "skipped", provider: "duckduckgo_html", reason: "provider disabled" };
			const gate = await options.requestGate.beforeRequest(context.signal, (waitMs) => {
				context.onUpdate?.({
					content: `Waiting ${formatSeconds(waitMs)} before searching...`,
					details: { status: "progress", phase: "waiting", wait_ms: waitMs },
				});
			});
			if (gate.status === "blocked") {
				return failed("PROVIDER_BLOCKED", `DuckDuckGo recently blocked automated search requests. Retry after about ${formatSeconds(gate.retryAfterMs)}.`, params.query);
			}
			if (gate.status === "aborted") {
				return failed(userAborted(context) ? "ABORTED" : "TIMEOUT", gate.message, params.query);
			}

			const remaining = (context.deadlineAt ?? Number.POSITIVE_INFINITY) - context.now();
			if (remaining <= 0) return failed("TIMEOUT", "websearch deadline exceeded.", params.query);
			const timeoutSignal = AbortSignal.timeout(Math.min(options.config.timeout_seconds * 1000, remaining));
			const signal = AbortSignal.any([context.signal ?? new AbortController().signal, timeoutSignal]);
			const [{ searchDuckDuckGoHtml }, dispatcher] = await Promise.all([
				backendPromise ?? import("../duckduckgo-html.js"),
				resolveDispatcher(options.dispatcher),
			]);
			const effectiveUserSignal = context.userSignal ?? (context.deadlineAt === undefined ? context.signal : undefined);
			const result = await searchDuckDuckGoHtml({
				query: filteredLexicalQuery(params),
				limit: params.limit,
				config: options.config,
				dispatcher,
				fetchImpl: options.fetchImpl,
				signal,
				...(effectiveUserSignal !== undefined ? { userSignal: effectiveUserSignal } : {}),
				onDownloading(receivedBytes, expectedBytes) {
					context.onUpdate?.({
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
					context.onUpdate?.({
						content: "Parsing results...",
						details: { status: "progress", phase: "parsing" },
					});
				},
			});

			if (result.status === "failed") {
				if (result.details.error.code === "PROVIDER_BLOCKED") options.requestGate.markProviderBlocked();
				const deadlineExpired = context.signal?.aborted && !userAborted(context);
				const details = deadlineExpired && (result.details.error.code === "ABORTED" || result.details.error.code === "CONNECTION_FAILED")
					? { ...result.details, error: { code: "TIMEOUT" as const, message: result.details.error.message } }
					: result.details;
				return { status: "failed", provider: "duckduckgo_html", details };
			}
			return { status: "success", provider: "duckduckgo_html", results: result.results, downloadedBytes: result.downloadedBytes };
		},
	};
}

function resolveDispatcher(value: Dispatcher | (() => Promise<Dispatcher>)): Promise<Dispatcher> {
	return typeof value === "function" ? value() : Promise.resolve(value);
}

function failed(code: WebSearchFailureDetails["error"]["code"], message: string, query: string): SearchProviderResult {
	return {
		status: "failed",
		provider: "duckduckgo_html",
		details: {
			status: "failed",
			error: { code, message },
			query,
			provider: "duckduckgo_html",
		},
	};
}

function formatSeconds(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000));
	return `${seconds}s`;
}

function userAborted(context: SearchProviderContext): boolean { return context.userSignal?.aborted === true || context.deadlineAt === undefined && context.signal?.aborted === true; }
