import { runtimeConfigFailure } from "./runtime-errors.js";
import type { WebSearchCapability, WebSearchCapabilityOptions } from "./runtime-types.js";
import { providerSignature, SearchCache } from "./search-cache.js";
import { SearchRequestGate } from "./search-request-gate.js";
import { resolveSearchApiKey } from "./search-providers/api-key.js";
import { SearchProviderRouter } from "./search-providers/router.js";
import type { SearchProviderContext, WebSearchProvider } from "./search-providers/types.js";
import type { WebToolsConfig } from "./types.js";
import { executeWebSearch } from "./websearch-tool.js";

export interface WebSearchProviderLoaders {
	brave(config: WebToolsConfig, options: WebSearchCapabilityOptions): Promise<WebSearchProvider>;
	exa(config: WebToolsConfig, options: WebSearchCapabilityOptions): Promise<WebSearchProvider>;
	tavily(config: WebToolsConfig, options: WebSearchCapabilityOptions): Promise<WebSearchProvider>;
	duckDuckGo(config: WebToolsConfig, options: WebSearchCapabilityOptions, requestGate: SearchRequestGate): Promise<WebSearchProvider>;
}

const defaultProviderLoaders: WebSearchProviderLoaders = {
	async brave(config, options) {
		const { createApiSearchProvider } = await import("./search-providers/api-provider.js");
		return createApiSearchProvider({ id: "brave_api", config: config.websearch.brave_api, dispatcher: options.getDispatcher, fetchImpl: options.fetchImpl });
	},
	async exa(config, options) {
		const { createApiSearchProvider } = await import("./search-providers/api-provider.js");
		return createApiSearchProvider({ id: "exa_api", config: config.websearch.exa_api, dispatcher: options.getDispatcher, fetchImpl: options.fetchImpl });
	},
	async tavily(config, options) {
		const { createApiSearchProvider } = await import("./search-providers/api-provider.js");
		return createApiSearchProvider({ id: "tavily", config: config.websearch.tavily, dispatcher: options.getDispatcher, fetchImpl: options.fetchImpl });
	},
	async duckDuckGo(config, options, requestGate) {
		const { createDuckDuckGoHtmlProvider } = await import("./search-providers/duckduckgo-html-provider.js");
		return createDuckDuckGoHtmlProvider({
			config: config.websearch.duckduckgo_html,
			dispatcher: options.getDispatcher,
			fetchImpl: options.fetchImpl,
			requestGate,
		});
	},
};

/** Search-only session state; concrete providers load only if the router reaches their branch. */
export function createWebSearchRuntime(
	options: WebSearchCapabilityOptions,
	providerLoaders: WebSearchProviderLoaders = defaultProviderLoaders,
): WebSearchCapability {
	let searches = new SearchCache(options.now);
	let searchCacheTtlSeconds: number | undefined;
	let searchRequests = new SearchRequestGate(options.now);
	let searchGateSignature = "";
	let searchRouter: SearchProviderRouter | undefined;
	let searchRouterSignature = "";
	let searchRouterUpdate = Promise.resolve();
	let pendingRouterUpdates = 0;
	const getSearchRouter = async (config: WebToolsConfig, signature: string): Promise<SearchProviderRouter> => {
		if (pendingRouterUpdates === 0 && searchRouter !== undefined && searchRouterSignature === signature) return searchRouter;
		pendingRouterUpdates += 1;
		searchRouterUpdate = searchRouterUpdate.catch(() => undefined).then(async () => {
			if (searchRouter !== undefined && searchRouterSignature === signature) return;
			await searchRouter?.close();
			searchRouter = new SearchProviderRouter(
				options.searchProviders ?? createSearchProviders(config, options, searchRequests, providerLoaders),
				config.websearch,
			);
			searchRouterSignature = signature;
		});
		try {
			await searchRouterUpdate;
		} finally {
			pendingRouterUpdates -= 1;
		}
		if (searchRouter === undefined) throw new Error("websearch router failed to initialize");
		return searchRouter;
	};

	return {
		async search(params, context) {
			let config: WebToolsConfig;
			try {
				config = await options.loadConfig();
			} catch (error) {
				return runtimeConfigFailure("websearch", error);
			}
			options.setAllowedFakeIpRanges(config.network.fake_ip_ranges);
			if (searchCacheTtlSeconds !== config.websearch.cache_ttl_seconds) {
				searches = new SearchCache(options.now, config.websearch.cache_ttl_seconds * 1000);
				searchCacheTtlSeconds = config.websearch.cache_ttl_seconds;
			}
			const gateSignature = `${config.websearch.duckduckgo_html.min_interval_seconds}:${config.websearch.duckduckgo_html.blocked_cooldown_seconds}`;
			if (gateSignature !== searchGateSignature) {
				searchRequests.clear();
				searchRequests = new SearchRequestGate(
					options.now,
					config.websearch.duckduckgo_html.min_interval_seconds * 1000,
					config.websearch.duckduckgo_html.blocked_cooldown_seconds * 1000,
				);
				searchGateSignature = gateSignature;
			}
			const signature = providerSignature(config.websearch);
			const routerSignature = `${signature}:${gateSignature}`;
			const router = await getSearchRouter(config, routerSignature);
			return executeWebSearch(params, { searches, router, providerSignature: signature, config, context, now: options.now, corpus: options.searchCorpus });
		},
		async close() {
			searches.clear();
			searchRequests.clear();
			await searchRouterUpdate.catch(() => undefined);
			await searchRouter?.close();
			searchRouter = undefined;
		},
	};
}

function createSearchProviders(
	config: WebToolsConfig,
	options: WebSearchCapabilityOptions,
	requestGate: SearchRequestGate,
	providerLoaders: WebSearchProviderLoaders,
): WebSearchProvider[] {
	const providers: WebSearchProvider[] = [];
	if (config.websearch.brave_api.enabled && resolveSearchApiKey(config.websearch.brave_api.api_key) !== undefined) {
		providers.push(createLazyProvider("brave_api", () => providerLoaders.brave(config, options)));
	}
	if (config.websearch.exa_api.enabled && resolveSearchApiKey(config.websearch.exa_api.api_key) !== undefined) {
		providers.push(createLazyProvider("exa_api", () => providerLoaders.exa(config, options)));
	}
	if (config.websearch.tavily.enabled && resolveSearchApiKey(config.websearch.tavily.api_key) !== undefined) {
		providers.push(createLazyProvider("tavily", () => providerLoaders.tavily(config, options)));
	}
	if (config.websearch.duckduckgo_html.enabled) {
		providers.push(createLazyProvider("duckduckgo_html", () => providerLoaders.duckDuckGo(config, options, requestGate)));
	}
	return providers;
}

function createLazyProvider(
	id: WebSearchProvider["id"],
	load: () => Promise<WebSearchProvider>,
): WebSearchProvider {
	let providerPromise: Promise<WebSearchProvider> | undefined;
	const getProvider = (): Promise<WebSearchProvider> => {
		if (providerPromise !== undefined) return providerPromise;
		const pending = load();
		providerPromise = pending;
		void pending.catch(() => {
			if (providerPromise === pending) providerPromise = undefined;
		});
		return pending;
	};
	return {
		id,
		async search(params, context: SearchProviderContext) {
			return (await getProvider()).search(params, context);
		},
		async close() {
			const provider = await settledProvider(providerPromise);
			await provider?.close?.();
			providerPromise = undefined;
		},
	};
}

async function settledProvider(pending: Promise<WebSearchProvider> | undefined): Promise<WebSearchProvider | undefined> {
	return pending === undefined ? undefined : pending.catch(() => undefined);
}
