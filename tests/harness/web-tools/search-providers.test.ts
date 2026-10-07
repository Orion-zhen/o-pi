import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";

import { defaultWebToolsConfig } from "./config-fixture.ts";
import { resolveSearchApiKey } from "../../../src/harness/web-tools/search-providers/api-key.ts";
import { buildBraveRequest, buildExaRequest, buildTavilyRequest, buildTinyfishRequest, searchApiProvider, normalizeProviderResponse } from "../../../src/harness/web-tools/search-providers/api-provider.ts";
import { normalizeSearchParams } from "../../../src/harness/web-tools/search-providers/query.ts";
import { preserveEnv } from "../../helpers/lifecycle.ts";
import { httpResponse } from "../../helpers/http.ts";

preserveEnv("BRAVE_SEARCH_API_KEY", "WEBSEARCH_API_KEY_TEST");

describe("搜索参数与提供方", () => {
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

	it("只提取域名条件，保留其他查询内容", () => {
		const query = 'site:docs.example.com -site:spam.example "WidgetError" v2.4 filetype:pdf intitle:guide';
		expect(normalizeSearchParams({ query }, 8)).toEqual({
			query, limit: 8,
			textQuery: '"WidgetError" v2.4 filetype:pdf intitle:guide',
			includeDomains: ["docs.example.com"],
			excludeDomains: ["spam.example"],
		});
	});

	it("映射 Brave、Exa、Tavily 稳定参数", () => {
		const config = defaultWebToolsConfig().websearch;
		const exact = normalizeSearchParams(
			{ query: "site:example.com -site:spam.test WidgetError", limit: 4 },
			8,
			{ includeDomains: ["docs.example"], excludeDomains: ["blocked.example"] },
		);
		const brave = buildBraveRequest(config.brave_api, exact, "brave-secret");
		expect(brave.url.searchParams.get("count")).toBe("4");
		expect(brave.url.searchParams.get("q")).toContain("(site:docs.example OR site:example.com)");
		expect(brave.url.searchParams.get("q")).toContain("-site:blocked.example");
		expect(brave.url.searchParams.has("freshness")).toBe(false);
		expect(brave.headers["X-Subscription-Token"]).toBe("brave-secret");

		const paper = normalizeSearchParams({ query: "research paper sparse attention", limit: 5 }, 8);
		const exaBody = JSON.parse(buildExaRequest(config.exa_api, paper, "exa-secret").body ?? "null") as Record<string, unknown>;
		expect(exaBody).toMatchObject({ query: paper.query, type: "auto", numResults: 5 });
		expect(exaBody).not.toHaveProperty("category");
		expect(exaBody).not.toHaveProperty("startPublishedDate");
		expect(exaBody).not.toHaveProperty("endPublishedDate");
		expect(exaBody).not.toHaveProperty("text");
		expect(exaBody).not.toHaveProperty("summary");

		const basic = JSON.parse(buildTavilyRequest(config.tavily, exact, "tvly-secret").body ?? "null") as Record<string, unknown>;
		expect(basic).toMatchObject({
			query: "WidgetError",
			max_results: 4,
			search_depth: "basic",
			auto_parameters: false,
			include_answer: false,
			include_raw_content: false,
			include_domains: ["docs.example", "example.com"],
			exclude_domains: ["blocked.example", "spam.test"],
		});
		expect(basic).not.toHaveProperty("time_range");
		expect(basic).not.toHaveProperty("start_date");
		expect(basic).not.toHaveProperty("end_date");
		const research = JSON.parse(buildTavilyRequest(config.tavily, paper, "tvly-secret").body ?? "null") as Record<string, unknown>;
		expect(research.search_depth).toBe("basic");
	});

	it.each([11, 20])("Exa 和 Tavily 将 %i 条结果限制直接传给 API", (limit) => {
		const config = defaultWebToolsConfig().websearch;
		const params = normalizeSearchParams({ query: "pi docs", limit }, 8);
		const exa = buildExaRequest(config.exa_api, params, "exa-secret");
		const tavily = buildTavilyRequest(config.tavily, params, "tavily-secret");
		expect(JSON.parse(exa.body ?? "null")).toMatchObject({ numResults: limit });
		expect(JSON.parse(tavily.body ?? "null")).toMatchObject({ max_results: limit });
	});

	it("规范化三家响应并忽略 provider 原生相关度字段", () => {
		const params = normalizeSearchParams({ query: "Alpha Beta Gamma", limit: 3 }, 8);
		expect(normalizeProviderResponse("brave_api", { web: { results: [{ title: "A", url: "https://a.test/", description: "Alpha" }] } }, params, 120)).toMatchObject({ status: "success", results: [{ snippet: "Alpha" }] });
		expect(normalizeProviderResponse("exa_api", { results: [{ title: "B", url: "https://b.test/", highlights: ["Beta"], highlightScores: [0.8] }] }, params, 120)).toMatchObject({ status: "success", results: [{ snippet: "Beta" }] });
		expect(normalizeProviderResponse("tavily", { results: [{ title: "C", url: "https://c.test/", content: "Gamma", score: 0.7 }] }, params, 120)).toMatchObject({ status: "success", results: [{ snippet: "Gamma" }] });
	});

	it.each(["brave_api", "exa_api", "tavily", "tinyfish"] as const)("%s 只按规范化 URL 去重，保留同标题不同页面", (id) => {
		const rows = [
			{ title: "Same title", url: "https://example.com/docs?utm_source=x#top" },
			{ title: "Same title", url: "https://example.com/docs" },
			{ title: "Same title", url: "https://example.com/other" },
			{ title: "Invalid", url: "not-a-url" },
			{ title: "Invalid", url: "javascript:alert(1)" },
		];
		const result = normalizeProviderResponse(id, id === "brave_api" ? { web: { results: rows } } : { results: rows }, normalizeSearchParams({ query: "查询结果可使用不同语言" }, 8), 100);
		expect(result).toMatchObject({ status: "success", results: [
			{ rank: 1, title: "Same title", url: "https://example.com/docs" },
			{ rank: 2, title: "Same title", url: "https://example.com/other" },
		] });
	});

	it("TinyFish 使用 GET、凭据头、结构化域名参数和 snippet", () => {
		const params = normalizeSearchParams({ query: "site:example.com site:docs.test -site:spam.test Pi", limit: 4 }, 8);
		const request = buildTinyfishRequest(defaultWebToolsConfig().websearch.tinyfish, params, "tinyfish-secret");
		expect(request.method).toBe("GET");
		expect(request.url.origin).toBe("https://api.search.tinyfish.ai");
		expect(Object.fromEntries(request.url.searchParams)).toEqual({ query: "Pi", include_domains: "docs.test,example.com", exclude_domains: "spam.test" });
		expect(request.headers["X-API-Key"]).toBe("tinyfish-secret");
		expect(request.url.toString()).not.toContain("tinyfish-secret");
		expect(normalizeProviderResponse("tinyfish", { results: [
			{ position: 4, title: "Pi docs", url: "https://example.com/", snippet: "Pi reference" },
		] }, params, 123)).toMatchObject({ status: "success", provider: "tinyfish", downloadedBytes: 123,
			results: [{ rank: 1, title: "Pi docs", url: "https://example.com/", snippet: "Pi reference" }] });
	});

	it("总 deadline 在发请求前生效", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "secret";
		const fetchImpl = vi.fn(async () => { throw new Error("must not fetch"); });
		const config = defaultWebToolsConfig().websearch.brave_api;
		await expect(searchApiProvider({ id: "brave_api", config, key: "secret", dispatcher: async () => new Agent(), fetchImpl },
			normalizeSearchParams({ query: "pi" }, 8), { now: () => 2, deadlineAt: 1 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "TIMEOUT" } } });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("HTTP 状态映射 Retry-After，且错误不泄漏 API key", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "brave-secret";
		const config = defaultWebToolsConfig().websearch.brave_api;
		const options = { id: "brave_api" as const, config, key: "brave-secret", dispatcher: async () => new Agent(), fetchImpl: async () => httpResponse(429, '{"error":"limited"}', { "retry-after": "2" }) };
		await expect(searchApiProvider(options, normalizeSearchParams({ query: "pi" }, 8), { now: () => 0, deadlineAt: 10_000 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "RATE_LIMITED" }, http_status: 429, retry_after_ms: 2000 } });
		options.fetchImpl = async () => { throw new Error("failed brave-secret"); };
		const failed = await searchApiProvider(options, normalizeSearchParams({ query: "pi" }, 8), { now: () => 0, deadlineAt: 10_000 });
		expect(failed).toMatchObject({ status: "failed", details: { error: { code: "CONNECTION_FAILED" } } });
		expect(JSON.stringify(failed)).not.toContain("brave-secret");
	});
});
