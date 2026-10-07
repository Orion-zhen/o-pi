import { runtimeConfigFailure } from "../core/runtime-errors.ts";
import type { WebSearchCapability, WebCapabilityOptions } from "../core/runtime-types.ts";
import type { WebSearchProviderId } from "../core/types.ts";
import { SearchFlights, searchFlightKey } from "./search-flights.ts";
import { resolveSearchApiKey } from "../search-providers/api-key.ts";
import { searchApiProvider } from "../search-providers/api-provider.ts";
import { normalizeSearchParams } from "../search-providers/query.ts";
import { searchProviders } from "../search-providers/router.ts";
import type { ResolvedSearchProvider, WebSearchProvider } from "../search-providers/types.ts";
import type { WebToolsConfig } from "../config-types.ts";
import { webSearchResult } from "./websearch-tool.ts";

/** 会话只持有并发请求。提供方与凭据使用本次配置快照。 */
export function createWebSearchRuntime(options: WebCapabilityOptions): WebSearchCapability {
	const searches = new SearchFlights();
	return {
		async search(params, context) {
			let config: WebToolsConfig;
			try {
				config = await options.loadConfig();
			} catch (error) {
				return runtimeConfigFailure("websearch", error);
			}
			const primary = resolveProviders(config.websearch, config.websearch.primary_providers);
			const auxiliary = resolveProviders(config.websearch, config.websearch.auxiliary_providers);
			const startedAt = options.now();
			const normalized = normalizeSearchParams(params, config.websearch.default_results, {
				includeDomains: config.websearch.include_domains,
				excludeDomains: config.websearch.exclude_domains,
			});
			if (normalized.includeDomains.some((domain) => normalized.excludeDomains.includes(domain))) {
				return webSearchResult({
					status: "failed", error: { code: "INVALID_ARGUMENT", message: "site: and -site: domains must not overlap." },
					duration_ms: options.now() - startedAt,
				});
			}
			const key = searchFlightKey(normalized, config, [...primary, ...auxiliary]);
			context.onUpdate?.({ content: "Searching...", details: { status: "progress", phase: "requesting" } });
			const shared = { dispatcher: () => options.getDispatcher(config.network), fetchImpl: options.fetchImpl };
			const bindProvider = (provider: ResolvedSearchProvider): WebSearchProvider => ({
				id: provider.id, maxResults: provider.config.max_results,
				async search(params, context) {
					if (provider.id === "exa_mcp") {
						const { searchExaMcp } = await import("../search-providers/exa-mcp-provider.ts");
						return searchExaMcp({ config: provider.config, ...shared }, params, context);
					}
					return searchApiProvider({ ...provider, ...shared }, params, context);
				},
			});
			const routed = await searches.run(key, context, ({ signal: userSignal, onUpdate }) => {
				// 超时属于共享任务，后来加入的调用不重置预算。
				const deadlineAt = startedAt + config.websearch.total_deadline_seconds * 1000;
				const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineAt - options.now()));
				return searchProviders({
					primary: primary.map(bindProvider), auxiliary: auxiliary.map(bindProvider),
				}, normalized, {
					signal: AbortSignal.any([userSignal, deadlineSignal]), userSignal,
					now: options.now, onUpdate, deadlineAt,
				});
			});
			return webSearchResult({ ...routed, query: normalized.query, duration_ms: options.now() - startedAt });
		},
		async close() {
			await searches.close();
		},
	};
}

function resolveProviders(config: WebToolsConfig["websearch"], order: readonly WebSearchProviderId[]): ResolvedSearchProvider[] {
	const providers: ResolvedSearchProvider[] = [];
	for (const id of order) {
		if (!config[id].enabled) continue;
		if (id === "exa_mcp") {
			providers.push({ id, config: { ...config[id] } });
			continue;
		}
		const { api_key, ...providerConfig } = config[id];
		const key = resolveSearchApiKey(api_key);
		if (id === "anysearch") providers.push({ id, config: providerConfig, key });
		else if (key !== undefined) providers.push({ id, config: providerConfig, key });
	}
	return providers;
}
