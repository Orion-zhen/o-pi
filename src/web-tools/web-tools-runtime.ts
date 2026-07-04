import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import { defaultCookiePath, loadWebToolsConfig, WebToolsConfigError } from "./config.js";
import { NetscapeCookieStore } from "./cookie-store.js";
import { createSecureLookup } from "./network-policy.js";
import { SearchRequestGate } from "./search-request-gate.js";
import { SearchCache } from "./search-cache.js";
import { SnapshotCache } from "./snapshot-cache.js";
import type {
	WebFetchExecutionContext,
	WebFetchParams,
	WebHttpRequestInit,
	WebHttpResponse,
	WebSearchExecutionContext,
	WebSearchParams,
	WebSearchResult,
	WebFetchResult,
	WebToolsRuntime,
	WebToolsRuntimeOptions,
} from "./types.js";
import { executeWebFetch } from "./webfetch-tool.js";
import { executeWebSearch } from "./websearch-tool.js";

export function createWebToolsRuntime(options: WebToolsRuntimeOptions = {}): WebToolsRuntime {
	let allowedFakeIpRanges: readonly string[] = [];
	const dispatcher = options.dispatcher ?? createDefaultDispatcher(() => allowedFakeIpRanges);
	const cookieStore = new NetscapeCookieStore(options.cookiePath ?? defaultCookiePath());
	const snapshots = new SnapshotCache(options.now);
	const searches = new SearchCache(options.now);
	const searchRequests = new SearchRequestGate(options.now);
	const approvedAuthOrigins = new Set<string>();
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? defaultFetch;

	return {
		async fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult> {
			let config;
			try {
				config = await loadWebToolsConfig();
			} catch (error) {
				const message = error instanceof WebToolsConfigError ? error.message : String(error);
				const details = {
					status: "failed" as const,
					error: { code: "CONFIG_ERROR" as const, message },
					duration_ms: 0,
				};
				return { content: JSON.stringify(details, null, 2), details };
			}
			allowedFakeIpRanges = config.network.fake_ip_ranges;
			return executeWebFetch(params, {
				dispatcher,
				fetchImpl,
				cookieStore,
				snapshots,
				approvedAuthOrigins,
				config,
				context,
				now,
			});
		},
		async search(params: WebSearchParams, context: WebSearchExecutionContext): Promise<WebSearchResult> {
			let config;
			try {
				config = await loadWebToolsConfig();
			} catch (error) {
				const message = error instanceof WebToolsConfigError ? error.message : String(error);
				const details = {
					status: "failed" as const,
					error: { code: "CONFIG_ERROR" as const, message },
					provider: "duckduckgo_html" as const,
					duration_ms: 0,
				};
				return { content: JSON.stringify(details, null, 2), details };
			}
			allowedFakeIpRanges = config.network.fake_ip_ranges;
			return executeWebSearch(params, {
				dispatcher,
				fetchImpl,
				searches,
				requestGate: searchRequests,
				config,
				context,
				now,
			});
		},
		async close(): Promise<void> {
			snapshots.clear();
			searches.clear();
			searchRequests.clear();
			approvedAuthOrigins.clear();
			await dispatcher.close();
		},
	};
}

function createDefaultDispatcher(getAllowedFakeIpRanges: () => readonly string[]): Dispatcher {
	return new Agent({
		connect: { lookup: createSecureLookup(getAllowedFakeIpRanges) },
	});
}

async function defaultFetch(input: URL, init: WebHttpRequestInit): Promise<WebHttpResponse> {
	const response = await undiciFetch(input, init);
	return {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		body: response.body,
	};
}
