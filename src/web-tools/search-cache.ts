import type { WebSearchItem, WebSearchRecency } from "./types.js";

export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
export const SEARCH_CACHE_MAX_ENTRIES = 64;

/** 缓存单次成功搜索；key 已包含 query、recency、region 和 limit。 */
export interface CachedSearch {
	key: string;
	createdAt: number;
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

export function searchCacheKey(query: string, recency: WebSearchRecency | undefined, region: string, limit: number): string {
	return [query.trim(), recency ?? "", region, String(limit)].join("\0");
}
