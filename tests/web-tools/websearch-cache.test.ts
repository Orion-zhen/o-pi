import { describe, expect, it } from "vitest";

import { SearchCache, searchCacheKey } from "../../src/web-tools/search-cache.js";
import { defaultWebToolsConfig } from "../../src/web-tools/config.js";

describe("websearch cache", () => {
	it("使用 TTL、LRU 和 clear", () => {
		let now = 1000;
		const cache = new SearchCache(() => now, 100, 2);
		cache.set({ key: "a", createdAt: now, provider: "exa_mcp", downloadedBytes: 1, results: [{ rank: 1, title: "A", url: "https://a.test/" }] });
		cache.set({ key: "b", createdAt: now, provider: "duckduckgo_html", downloadedBytes: 2, results: [{ rank: 1, title: "B", url: "https://b.test/" }] });
		expect(cache.get("a")?.results[0]?.title).toBe("A");
		cache.set({ key: "c", createdAt: now, provider: "exa_mcp", downloadedBytes: 3, results: [{ rank: 1, title: "C", url: "https://c.test/" }] });
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBeDefined();
		now += 101;
		expect(cache.get("a")).toBeUndefined();
		cache.clear();
		expect(cache.get("c")).toBeUndefined();
	});

	it("缓存 key 包含 query、limit 和 provider 签名", () => {
		const config = defaultWebToolsConfig().websearch;
		const changed = defaultWebToolsConfig().websearch;
		changed.duckduckgo_html.region = "us-en";
		expect(searchCacheKey(" pi ", 8, config).startsWith(["pi", "8"].join("\0"))).toBe(true);
		expect(searchCacheKey("pi", 2, config)).not.toBe(searchCacheKey("pi", 8, config));
		expect(searchCacheKey("pi", 8, changed)).not.toBe(searchCacheKey("pi", 8, config));
	});
});
