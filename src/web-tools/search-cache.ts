import type { WebSearchItem, WebSearchProviderId, WebToolsConfig } from "./types.js";

export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
export const SEARCH_CACHE_MAX_ENTRIES = 64;

/** 缓存单次成功搜索；key 已包含 query、limit 和 provider 签名。 */
export interface CachedSearch {
	key: string;
	createdAt: number;
	provider: WebSearchProviderId;
	results: WebSearchItem[];
	downloadedBytes: number;
}

/** 会话内 LRU 搜索缓存；不持久化，避免跨会话混用搜索结果。 */
export class SearchCache {
	private readonly entries = new Map<string, CachedSearch>();

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly ttlMs: number = SEARCH_CACHE_TTL_MS,
		private readonly maxEntries: number = SEARCH_CACHE_MAX_ENTRIES,
	) {}

	get(key: string): CachedSearch | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		if (this.now() - entry.createdAt > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return {
			...entry,
			results: entry.results.map((item) => ({ ...item })),
		};
	}

	set(entry: CachedSearch): void {
		this.entries.delete(entry.key);
		this.entries.set(entry.key, {
			...entry,
			results: entry.results.map((item) => ({ ...item })),
		});
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	clear(): void {
		this.entries.clear();
	}
}

export function searchCacheKey(query: string, limit: number, config: WebToolsConfig["websearch"], signature = providerSignature(config)): string {
	return [query.trim(), String(limit), signature].join("\0");
}

export function providerSignature(config: WebToolsConfig["websearch"]): string {
	return JSON.stringify(config.provider_order
		.map((provider) => {
			if (provider === "exa_mcp") return [provider, config.exa_mcp.enabled, config.exa_mcp.url, config.exa_mcp.tool, config.exa_mcp.type];
			return [provider, config.duckduckgo_html.enabled, config.duckduckgo_html.region];
		}));
}
