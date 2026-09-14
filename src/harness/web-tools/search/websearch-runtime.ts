import { runtimeConfigFailure } from "../core/runtime-errors.ts";
import type { WebSearchCapability, WebCapabilityOptions } from "../core/runtime-types.ts";
import { providerSignature, SearchFlights } from "./search-flights.ts";
import { SearchRequestGate } from "./search-request-gate.ts";
import { resolveSearchApiKey } from "../search-providers/api-key.ts";
import { SearchProviderRouter } from "../search-providers/router.ts";
import type { WebSearchProvider } from "../search-providers/types.ts";
import type { WebToolsConfig } from "../config-types.ts";
import { networkConfigSignature } from "../network/dispatcher.ts";
import { executeWebSearch } from "./websearch-tool.ts";

/** 会话只持有并发请求和 DDG 节流状态。路由与凭据使用本次配置快照。 */
export function createWebSearchRuntime(options: WebCapabilityOptions): WebSearchCapability {
	const searches = new SearchFlights();
	let gate: { interval: number; cooldown: number; requests: SearchRequestGate } | undefined;
	let apiModule: Promise<typeof import("../search-providers/api-provider.ts")> | undefined;
	let ddgModule: Promise<typeof import("../search-providers/duckduckgo-html-provider.ts")> | undefined;
	return {
		async search(params, context) {
			let config: WebToolsConfig;
			try {
				config = await options.loadConfig();
			} catch (error) {
				return runtimeConfigFailure("websearch", error);
			}
			const interval = config.websearch.duckduckgo_html.min_interval_seconds * 1000;
			const cooldown = config.websearch.duckduckgo_html.blocked_cooldown_seconds * 1000;
			if (gate?.interval !== interval || gate.cooldown !== cooldown) {
				gate?.requests.clear();
				gate = { interval, cooldown, requests: new SearchRequestGate(options.now, interval, cooldown) };
			}
			const router = new SearchProviderRouter(providers(config, gate.requests));
			const signature = `${providerSignature(config.websearch)}:${networkConfigSignature(config.network)}`;
			return executeWebSearch(params, { searches, router, providerSignature: signature, config, context, now: options.now });
		},
		async close() {
			searches.clear();
			gate?.requests.clear();
		},
	};

	function providers(config: WebToolsConfig, requestGate: SearchRequestGate): WebSearchProvider[] {
		const result: WebSearchProvider[] = [];
		const shared = { dispatcher: () => options.getDispatcher(config.network), fetchImpl: options.fetchImpl };
		const formal = [
			{ id: "brave_api", config: config.websearch.brave_api },
			{ id: "exa_api", config: config.websearch.exa_api },
			{ id: "tavily", config: config.websearch.tavily },
		] as const;
		for (const provider of formal) {
			if (!provider.config.enabled) continue;
			const key = resolveSearchApiKey(provider.config.api_key);
			if (key === undefined) continue;
			result.push({
				id: provider.id,
				async search(params, context) {
					apiModule ??= import("../search-providers/api-provider.ts");
					return (await apiModule).searchApiProvider({ ...provider, ...shared, key }, params, context);
				},
			});
		}
		if (config.websearch.duckduckgo_html.enabled) result.push({
			id: "duckduckgo_html",
			async search(params, context) {
				ddgModule ??= import("../search-providers/duckduckgo-html-provider.ts");
				return (await ddgModule).searchDuckDuckGoProvider({ config: config.websearch.duckduckgo_html, requestGate, ...shared }, params, context);
			},
		});
		return result;
	}
}
