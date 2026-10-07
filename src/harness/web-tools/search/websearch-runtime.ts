import { runtimeConfigFailure } from "../core/runtime-errors.ts";
import type { WebSearchCapability, WebCapabilityOptions } from "../core/runtime-types.ts";
import { providerSignature, SearchFlights } from "./search-flights.ts";
import { resolveSearchApiKey } from "../search-providers/api-key.ts";
import { SearchProviderRouter } from "../search-providers/router.ts";
import type { WebSearchProvider } from "../search-providers/types.ts";
import type { WebToolsConfig } from "../config-types.ts";
import { networkConfigSignature } from "../network/dispatcher.ts";
import { executeWebSearch } from "./websearch-tool.ts";

/** 会话只持有并发请求。路由与凭据使用本次配置快照。 */
export function createWebSearchRuntime(options: WebCapabilityOptions): WebSearchCapability {
	const searches = new SearchFlights();
	let apiModule: Promise<typeof import("../search-providers/api-provider.ts")> | undefined;
	return {
		async search(params, context) {
			let config: WebToolsConfig;
			try {
				config = await options.loadConfig();
			} catch (error) {
				return runtimeConfigFailure("websearch", error);
			}
			const router = new SearchProviderRouter({
				primary: providers(config, config.websearch.primary_providers),
				auxiliary: providers(config, config.websearch.auxiliary_providers),
			});
			const signature = `${providerSignature(config.websearch)}:${networkConfigSignature(config.network)}`;
			return executeWebSearch(params, { searches, router, providerSignature: signature, config, context, now: options.now });
		},
		async close() {
			searches.clear();
		},
	};

	function providers(config: WebToolsConfig, order: WebToolsConfig["websearch"]["primary_providers"]): WebSearchProvider[] {
		const result: WebSearchProvider[] = [];
		const shared = { dispatcher: () => options.getDispatcher(config.network), fetchImpl: options.fetchImpl };
		const formal = {
			brave_api: { id: "brave_api", config: config.websearch.brave_api },
			exa_api: { id: "exa_api", config: config.websearch.exa_api },
			tavily: { id: "tavily", config: config.websearch.tavily },
			tinyfish: { id: "tinyfish", config: config.websearch.tinyfish },
			anysearch: { id: "anysearch", config: config.websearch.anysearch },
		} as const;
		for (const id of order) {
			if (!config.websearch[id].enabled) continue;
			const provider = formal[id];
			const key = resolveSearchApiKey(provider.config.api_key);
			const credentials = provider.id === "anysearch" ? { ...provider, key }
				: key === undefined ? undefined : { ...provider, key };
			if (credentials === undefined) continue;
			result.push({
				id: provider.id,
				maxResults: provider.config.max_results,
				async search(params, context) {
					apiModule ??= import("../search-providers/api-provider.ts");
					return (await apiModule).searchApiProvider({ ...credentials, ...shared }, params, context);
				},
			});
		}
		return result;
	}
}
