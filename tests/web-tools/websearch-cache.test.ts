import { describe, expect, it } from "vitest";

import { providerSignature, SearchCache, searchCacheKey } from "../../src/web-tools/search-cache.js";
import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { preserveEnv } from "../helpers/lifecycle.js";

preserveEnv("WEBSEARCH_SIGNATURE_KEY");

describe("websearch cache", () => {
	it("相同 in-flight 请求 singleflight，完成后允许重新执行", async () => {
		const cache = new SearchCache(() => 0);
		let calls = 0;
		let release: (() => void) | undefined;
		const task = () => cache.runSingleflight("same", async () => { calls += 1; await new Promise<void>((resolve) => { release = resolve; }); return calls; });
		const first = task();
		const second = task();
		expect(calls).toBe(1);
		release?.();
		await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
		const third = cache.runSingleflight("same", async () => { calls += 1; return calls; });
		await expect(third).resolves.toBe(2);
	});

	it("使用 TTL、LRU 和 clear", () => {
		let now = 1000;
		const cache = new SearchCache(() => now, 100, 2);
		cache.set({ key: "a", createdAt: now, provider: "exa_api", downloadedBytes: 1, results: [{ rank: 1, title: "A", url: "https://a.test/" }] });
		cache.set({ key: "b", createdAt: now, provider: "duckduckgo_html", downloadedBytes: 2, results: [{ rank: 1, title: "B", url: "https://b.test/" }] });
		expect(cache.get("a")?.results[0]?.title).toBe("A");
		cache.set({ key: "c", createdAt: now, provider: "exa_api", downloadedBytes: 3, results: [{ rank: 1, title: "C", url: "https://c.test/" }] });
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

	it("provider 签名响应 key 变化但不包含密钥", () => {
		const config = defaultWebToolsConfig().websearch;
		config.brave_api.api_key = "literal-secret";
		const literal = providerSignature(config);
		expect(literal).not.toContain("literal-secret");

		config.brave_api.api_key = "$WEBSEARCH_SIGNATURE_KEY";
		process.env.WEBSEARCH_SIGNATURE_KEY = "first-secret";
		const first = providerSignature(config);
		process.env.WEBSEARCH_SIGNATURE_KEY = "second-secret";
		const second = providerSignature(config);
		expect(second).not.toBe(first);
		expect(second).not.toContain("second-secret");
	});
});
