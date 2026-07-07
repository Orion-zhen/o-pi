import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import { defaultCookiePath, loadWebToolsConfig, WebToolsConfigError } from "./config.js";
import { NetscapeCookieStore } from "./cookie-store.js";
import { createSecureLookup } from "./network-policy.js";
import { createDuckDuckGoHtmlProvider } from "./search-providers/duckduckgo-html-provider.js";
import { createExaMcpProvider, DefaultExaMcpClientFactory, type ExaMcpClientFactory } from "./search-providers/exa-mcp.js";
import { SearchProviderRouter } from "./search-providers/router.js";
import type { WebSearchProvider } from "./search-providers/types.js";
import { SearchRequestGate } from "./search-request-gate.js";
import { providerSignature, SearchCache } from "./search-cache.js";
import { SnapshotCache } from "./snapshot-cache.js";
import { escapeXml } from "./url-utils.js";
import type {
	WebFetchExecutionContext,
	WebFetchParams,
	WebHttpFetch,
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
	const approvedAuthOrigins = new Set<string>();
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const exaFactory = options.exaMcpClientFactory ?? new DefaultExaMcpClientFactory();
	let searches = new SearchCache(now);
	let searchCacheTtlSeconds: number | undefined;
	let searchRequests = new SearchRequestGate(now);
	let searchGateSignature = "";
	let searchRouter: SearchProviderRouter | undefined;
	let searchRouterSignature = "";

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
				return { content: failureContent("webfetch", details.error.code, details.error.message), details };
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
					duration_ms: 0,
				};
				return { content: failureContent("websearch", details.error.code, details.error.message), details };
			}
			allowedFakeIpRanges = config.network.fake_ip_ranges;
			if (searchCacheTtlSeconds !== config.websearch.cache_ttl_seconds) {
				searches = new SearchCache(now, config.websearch.cache_ttl_seconds * 1000);
				searchCacheTtlSeconds = config.websearch.cache_ttl_seconds;
			}
			const gateSignature = `${config.websearch.duckduckgo_html.min_interval_seconds}:${config.websearch.duckduckgo_html.blocked_cooldown_seconds}`;
			if (gateSignature !== searchGateSignature) {
				searchRequests.clear();
				searchRequests = new SearchRequestGate(
					now,
					config.websearch.duckduckgo_html.min_interval_seconds * 1000,
					config.websearch.duckduckgo_html.blocked_cooldown_seconds * 1000,
				);
				searchGateSignature = gateSignature;
			}
			const routerSignature = `${providerSignature(config.websearch)}:${gateSignature}`;
			if (searchRouter === undefined || routerSignature !== searchRouterSignature) {
				await searchRouter?.close();
				searchRouter = new SearchProviderRouter(
					options.searchProviders ?? createSearchProviders(config, dispatcher, fetchImpl, searchRequests, exaFactory),
					config.websearch,
				);
				searchRouterSignature = routerSignature;
			}
			return executeWebSearch(params, {
				searches,
				router: searchRouter,
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
			await searchRouter?.close();
			searchRouter = undefined;
			await dispatcher.close();
		},
	};
}

function failureContent(tool: "webfetch" | "websearch", code: string, message: string): string {
	return `<error tool="${tool}" code="${escapeXml(code)}">
${escapeXml(message)}
</error>`;
}

function createSearchProviders(
	config: Awaited<ReturnType<typeof loadWebToolsConfig>>,
	dispatcher: Dispatcher,
	fetchImpl: WebHttpFetch,
	requestGate: SearchRequestGate,
	exaFactory: ExaMcpClientFactory,
): WebSearchProvider[] {
	return [
		createExaMcpProvider(config.websearch.exa_mcp, exaFactory),
		createDuckDuckGoHtmlProvider({
			config: config.websearch.duckduckgo_html,
			dispatcher,
			fetchImpl,
			requestGate,
		}),
	];
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
