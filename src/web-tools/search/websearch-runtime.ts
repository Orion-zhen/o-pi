import { runtimeConfigFailure } from "../core/runtime-errors.js";
import type { WebSearchCapability, WebCapabilityOptions } from "../core/runtime-types.js";
import { providerSignature, SearchFlights } from "./search-flights.js";
import { SearchRequestGate } from "./search-request-gate.js";
import { resolveSearchApiKey } from "../search-providers/api-key.js";
import type { ApiProviderOptions } from "../search-providers/api-provider.js";
import { SearchProviderRouter } from "../search-providers/router.js";
import type { WebSearchProvider } from "../search-providers/types.js";
import type { WebToolsConfig } from "../core/types.js";
import { networkConfigSignature } from "../network/dispatcher.js";
import { executeWebSearch } from "./websearch-tool.js";

/** 管理搜索会话状态，路由命中后才加载具体提供方。 */
export function createWebSearchRuntime(options: WebCapabilityOptions): WebSearchCapability {
	const searches = new SearchFlights();
	let searchRequests = new SearchRequestGate(options.now);
	let searchGateSignature = "";
	let searchRouter: SearchProviderRouter | undefined;
	let searchRouterSignature = "";
	const getSearchRouter = (config: WebToolsConfig, signature: string): SearchProviderRouter => {
		if (searchRouter === undefined || searchRouterSignature !== signature) {
			searchRouter = new SearchProviderRouter(createSearchProviders(config, options, searchRequests));
			searchRouterSignature = signature;
		}
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
			const routerSignature = `${signature}:${gateSignature}:${networkConfigSignature(config.network)}`;
			const router = getSearchRouter(config, routerSignature);
			return executeWebSearch(params, { searches, router, providerSignature: signature, config, context, now: options.now });
		},
		async close() {
			searches.clear();
			searchRequests.clear();
			searchRouter = undefined;
		},
	};
}

function createSearchProviders(
	config: WebToolsConfig,
	options: WebCapabilityOptions,
	requestGate: SearchRequestGate,
): WebSearchProvider[] {
	const providers: WebSearchProvider[] = [];
	const shared = { dispatcher: () => options.getDispatcher(config.network), fetchImpl: options.fetchImpl };
	const formal: ApiProviderOptions[] = [
		{ id: "brave_api", config: config.websearch.brave_api, ...shared },
		{ id: "exa_api", config: config.websearch.exa_api, ...shared },
		{ id: "tavily", config: config.websearch.tavily, ...shared },
	];
	for (const provider of formal) {
		if (!provider.config.enabled || resolveSearchApiKey(provider.config.api_key) === undefined) continue;
		providers.push(createLazyProvider(provider.id, async () => {
			const { createApiSearchProvider } = await import("../search-providers/api-provider.js");
			return createApiSearchProvider(provider);
		}));
	}
	if (config.websearch.duckduckgo_html.enabled) {
		providers.push(createLazyProvider("duckduckgo_html", async () => {
			const { createDuckDuckGoHtmlProvider } = await import("../search-providers/duckduckgo-html-provider.js");
			return createDuckDuckGoHtmlProvider({ config: config.websearch.duckduckgo_html, requestGate, ...shared });
		}));
	}
	return providers;
}

function createLazyProvider(
	id: WebSearchProvider["id"],
	load: () => Promise<WebSearchProvider>,
): WebSearchProvider {
	let providerPromise: Promise<WebSearchProvider> | undefined;
	return {
		id,
		async search(params, context) {
			providerPromise ??= load();
			return (await providerPromise).search(params, context);
		},
	};
}
