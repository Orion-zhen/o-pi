import { createHash } from "node:crypto";

import { resolveSearchApiKey } from "./search-providers/api-key.js";
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
	private readonly inFlight = new Map<string, Promise<unknown>>();

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
		this.inFlight.clear();
	}

	runSingleflight<T>(key: string, execute: () => Promise<T>): Promise<T> {
		const existing = this.inFlight.get(key);
		if (existing !== undefined) return existing as Promise<T>;
		const pending = execute();
		this.inFlight.set(key, pending);
		void pending.finally(() => { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }).catch(() => undefined);
		return pending;
	}
}

export function searchCacheKey(query: string, limit: number, config: WebToolsConfig["websearch"], signature = providerSignature(config)): string {
	return [query.trim(), String(limit), signature].join("\0");
}

export function providerSignature(config: WebToolsConfig["websearch"]): string {
	return JSON.stringify({
		...config,
		brave_api: providerConfigSignature(config.brave_api),
		exa_api: providerConfigSignature(config.exa_api),
		tavily: providerConfigSignature(config.tavily),
	});
}

function providerConfigSignature<T extends { api_key: string }>(config: T): Omit<T, "api_key"> & { api_key: string } {
	const material = resolveSearchApiKey(config.api_key) ?? config.api_key;
	return { ...config, api_key: createHash("sha256").update(material).digest("hex") };
}
