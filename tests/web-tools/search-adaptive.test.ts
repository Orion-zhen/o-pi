import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";

import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { resolveSearchApiKey } from "../../src/web-tools/search-providers/api-key.js";
import { buildBraveRequest, buildExaRequest, buildTavilyRequest, createApiSearchProvider, normalizeProviderResponse } from "../../src/web-tools/search-providers/api-provider.js";
import { mergeSearchResults } from "../../src/web-tools/search-providers/merge.js";
import { assessSearchQuality } from "../../src/web-tools/search-providers/quality.js";
import { compileSearchQuery, normalizeSearchParams } from "../../src/web-tools/search-providers/query.js";
import { SearchCorpus } from "../../src/web-tools/search-corpus.js";
import { preserveEnv } from "../helpers/lifecycle.js";
import { httpResponse } from "../helpers/http.js";

preserveEnv("BRAVE_SEARCH_API_KEY", "WEBSEARCH_API_KEY_TEST");

describe("adaptive search compilation and providers", () => {
	it("api_key 支持明文和共享的 $ 环境变量引用", () => {
		process.env.WEBSEARCH_API_KEY_TEST = "env-secret";
		expect(resolveSearchApiKey("literal-secret")).toBe("literal-secret");
		expect(resolveSearchApiKey("$WEBSEARCH_API_KEY_TEST")).toBe("env-secret");
		expect(resolveSearchApiKey("${WEBSEARCH_API_KEY_TEST}")).toBe("env-secret");
		expect(resolveSearchApiKey("")).toBeUndefined();
		expect(resolveSearchApiKey("   ")).toBeUndefined();
		process.env.WEBSEARCH_API_KEY_TEST = "   ";
		expect(resolveSearchApiKey("$WEBSEARCH_API_KEY_TEST")).toBeUndefined();
		delete process.env.WEBSEARCH_API_KEY_TEST;
		expect(resolveSearchApiKey("$WEBSEARCH_API_KEY_TEST")).toBeUndefined();
	});

	it("编译 lexical/semantic query 并确定性分类", () => {
		const exact = compileSearchQuery({ query: 'site:docs.example.com -site:spam.example "WidgetError" v2.4 after:2025-01-01' });
		expect(exact).toMatchObject({
			lexicalQuery: 'site:docs.example.com -site:spam.example "WidgetError" v2.4 after:2025-01-01',
			semanticQuery: '"WidgetError" v2.4',
			intent: "exact",
			includeDomains: ["docs.example.com"],
			excludeDomains: ["spam.example"],
			freshness: { start: "2025-01-01" },
		});
		expect(compileSearchQuery({ query: "research papers about sparse mixture of experts routing" }).intent).toBe("paper");
		expect(compileSearchQuery({ query: "find practical approaches that compare several subtle tradeoffs across distributed teams and systems" }).intent).toBe("semantic");
		expect(compileSearchQuery({ query: "OpenAI API official documentation" }).intent).toBe("navigation");
	});

	it("映射 Brave、Exa、Tavily 稳定参数", () => {
		const config = defaultWebToolsConfig().websearch;
		const exact = normalizeSearchParams(
			{ query: "site:example.com -site:spam.test WidgetError", limit: 4, freshness: "week" },
			8,
			{ includeDomains: ["docs.example"], excludeDomains: ["blocked.example"] },
		);
		const brave = buildBraveRequest(config.brave_api, exact, "brave-secret");
		expect(brave.url.searchParams.get("q")).toContain("(site:docs.example OR site:example.com)");
		expect(brave.url.searchParams.get("q")).toContain("-site:blocked.example");
		expect(brave.url.searchParams.get("freshness")).toBe("pw");
		expect(brave.headers["X-Subscription-Token"]).toBe("brave-secret");

		const paper = normalizeSearchParams({ query: "research paper sparse attention", limit: 5, freshness: { start: "2025-01-01" } }, 8);
		const exaBody = JSON.parse(buildExaRequest(config.exa_api, paper, "exa-secret").body ?? "null") as Record<string, unknown>;
		expect(exaBody).toMatchObject({ type: "auto", category: "research paper", numResults: 6, startPublishedDate: "2025-01-01T00:00:00.000Z" });
		expect(exaBody).not.toHaveProperty("text");
		expect(exaBody).not.toHaveProperty("summary");

		const basic = JSON.parse(buildTavilyRequest(config.tavily, exact, "tvly-secret").body ?? "null") as Record<string, unknown>;
		expect(basic).toMatchObject({
			search_depth: "basic",
			auto_parameters: false,
			include_answer: false,
			include_raw_content: false,
			include_domains: ["docs.example", "example.com"],
			exclude_domains: ["blocked.example", "spam.test"],
		});
		const advanced = JSON.parse(buildTavilyRequest(config.tavily, { ...paper, lastFormalOpportunity: true }, "tvly-secret").body ?? "null") as Record<string, unknown>;
		expect(advanced.search_depth).toBe("advanced");
	});

	it("规范化三家响应并保留原生相关度", () => {
		expect(normalizeProviderResponse("brave_api", { web: { results: [{ title: "A", url: "https://a.test/", description: "Alpha" }] } }, 3)).toMatchObject({ status: "success", results: [{ snippet: "Alpha" }] });
		expect(normalizeProviderResponse("exa_api", { results: [{ title: "B", url: "https://b.test/", highlights: ["Beta"], highlightScores: [0.8] }] }, 3)).toMatchObject({ status: "success", results: [{ snippet: "Beta", score: 0.8 }] });
		expect(normalizeProviderResponse("tavily", { results: [{ title: "C", url: "https://c.test/", content: "Gamma", score: 0.7 }] }, 3)).toMatchObject({ status: "success", results: [{ snippet: "Gamma", score: 0.7 }] });
	});

	it("总 deadline 在发请求前生效", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "secret";
		const fetchImpl = vi.fn(async () => { throw new Error("must not fetch"); });
		const config = defaultWebToolsConfig().websearch.brave_api;
		const provider = createApiSearchProvider({ id: "brave_api", config, dispatcher: new Agent(), fetchImpl });
		await expect(provider.search(normalizeSearchParams({ query: "pi" }, 8), { now: () => 2, deadlineAt: 1 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "TIMEOUT" } } });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("HTTP 状态映射 Retry-After，且错误不泄漏 API key", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "brave-secret";
		const config = defaultWebToolsConfig().websearch.brave_api;
		let provider = createApiSearchProvider({ id: "brave_api", config, dispatcher: new Agent(), fetchImpl: async () => httpResponse(429, '{"error":"limited"}', { "retry-after": "2" }) });
		await expect(provider.search(normalizeSearchParams({ query: "pi" }, 8), { now: () => 0, deadlineAt: 10_000 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "RATE_LIMITED" }, http_status: 429, retry_after_ms: 2000 } });
		provider = createApiSearchProvider({ id: "brave_api", config, dispatcher: new Agent(), fetchImpl: async () => { throw new Error("failed brave-secret"); } });
		const failed = await provider.search(normalizeSearchParams({ query: "pi" }, 8), { now: () => 0, deadlineAt: 10_000 });
		expect(failed).toMatchObject({ status: "failed", details: { error: { code: "CONNECTION_FAILED" } } });
		expect(JSON.stringify(failed)).not.toContain("brave-secret");
	});
});

describe("adaptive search quality, merge and corpus", () => {
	it("区分 accepted、partial 和 soft miss，导航查询不要求域名多样性", () => {
		const query = compileSearchQuery({ query: "pi agent" });
		const strong = Array.from({ length: 3 }, (_, index) => ({ rank: index + 1, title: `Pi agent ${index}`, url: `https://d${index}.test/pi`, snippet: "Pi agent documentation snippet." }));
		expect(assessSearchQuality(strong, query, 3).quality).toBe("accepted");
		expect(assessSearchQuality(strong.slice(0, 1), query, 3).quality).toBe("partial");
		expect(assessSearchQuality([{ rank: 1, title: "Unrelated", url: "https://x.test/" }], query, 3).quality).toBe("soft_miss");
		const nav = compileSearchQuery({ query: "site:example.com pi docs" });
		const sameDomain = [{ rank: 1, title: "Pi docs", url: "https://example.com/pi", snippet: "Pi docs official documentation." }, { rank: 2, title: "Pi API", url: "https://example.com/api", snippet: "Pi docs API reference." }];
		expect(assessSearchQuality(sameDomain, nav, 2).quality).toBe("accepted");
	});

	it("URL/标题去重、RRF 共识加分、域名最多两条并保留 provenance", () => {
		const merged = mergeSearchResults([
			{ provider: "brave_api", weight: 1, results: [{ rank: 1, title: "Pi docs", url: "https://example.com/docs?utm_source=x#top" }, { rank: 2, title: "Pi API", url: "https://example.com/api" }, { rank: 3, title: "Pi guide", url: "https://example.com/guide" }] },
			{ provider: "tavily", weight: 0.9, results: [{ rank: 1, title: "Pi docs", url: "https://example.com/docs" }, { rank: 2, title: "Other", url: "https://other.test/pi" }] },
		], 5);
		expect(merged[0]).toMatchObject({ url: "https://example.com/docs", provenance: [{ provider: "brave_api" }, { provider: "tavily" }] });
		expect(merged.filter((item) => new URL(item.url).hostname === "example.com")).toHaveLength(2);
	});

	it("corpus 只保守复用近似且过滤兼容的强结果，并跟踪 fetch/cite", () => {
		let now = 0;
		const corpus = new SearchCorpus(() => now);
		const first = normalizeSearchParams({ query: "site:example.com pi coding agent docs", limit: 2 }, 8);
		const results = [{ rank: 1, title: "Pi docs", url: "https://example.com/pi", snippet: "Pi coding agent docs." }, { rank: 2, title: "Pi guide", url: "https://example.com/guide", snippet: "Pi coding agent guide." }];
		corpus.add(first, results, ["brave_api"]);
		expect(corpus.find(normalizeSearchParams({ query: "site:example.com pi coding agent docs guide", limit: 2 }, 8))).toBeDefined();
		expect(corpus.find(normalizeSearchParams({ query: "site:other.test pi coding agent docs guide", limit: 2 }, 8))).toBeUndefined();
		corpus.markFetched(results[0]?.url ?? "");
		corpus.markCited(results[1]?.url ?? "");
		expect(corpus.usage()).toEqual({ discovered: 2, fetched: 1, cited: 1 });
		now = 10;
		expect(corpus.recordQuery(first)).toBe(false);
		expect(corpus.recordQuery(normalizeSearchParams({ query: "site:example.com pi coding agent guide" }, 8))).toBe(true);
	});
});
