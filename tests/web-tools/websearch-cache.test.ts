import { describe, expect, it } from "vitest";

import { SearchCache, searchCacheKey } from "../../src/web-tools/search-cache.js";

describe("websearch cache", () => {
	it("使用 TTL、LRU 和 clear", () => {
		let now = 1000;
		const cache = new SearchCache(() => now, 100, 2);
		cache.set({ key: "a", createdAt: now, downloadedBytes: 1, results: [{ rank: 1, title: "A", url: "https://a.test/" }] });
		cache.set({ key: "b", createdAt: now, downloadedBytes: 2, results: [{ rank: 1, title: "B", url: "https://b.test/" }] });
		expect(cache.get("a")?.results[0]?.title).toBe("A");
		cache.set({ key: "c", createdAt: now, downloadedBytes: 3, results: [{ rank: 1, title: "C", url: "https://c.test/" }] });
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBeDefined();
		now += 101;
		expect(cache.get("a")).toBeUndefined();
		cache.clear();
		expect(cache.get("c")).toBeUndefined();
	});

	it("缓存 key 包含 query、recency、region 和 limit", () => {
		expect(searchCacheKey(" pi ", undefined, "wt-wt", 8)).toBe(["pi", "", "wt-wt", "8"].join("\0"));
		expect(searchCacheKey("pi", "day", "wt-wt", 8)).not.toBe(searchCacheKey("pi", undefined, "wt-wt", 8));
		expect(searchCacheKey("pi", undefined, "us-en", 8)).not.toBe(searchCacheKey("pi", undefined, "wt-wt", 8));
		expect(searchCacheKey("pi", undefined, "wt-wt", 2)).not.toBe(searchCacheKey("pi", undefined, "wt-wt", 8));
	});
});
