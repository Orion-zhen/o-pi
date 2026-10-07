import { describe, expect, it } from "vitest";

import { webSearchStructuredOutput } from "../../../src/harness/web-tools/search/structured-output.ts";
import { httpResponse } from "../../helpers/http.ts";
import { useWebSearch } from "./search-fixture.ts";

const fixture = useWebSearch();
const passage = "  WidgetError v2.4\n\t保留代码缩进和全部内容。\n".repeat(80);
const query = 'site:example.com -site:spam.test "WidgetError" v2.4 filetype:pdf';
const textQuery = '"WidgetError" v2.4 filetype:pdf';
const lexicalQuery = `${textQuery} (site:docs.example OR site:example.com) -site:blocked.example -site:spam.test`;

describe("搜索提供方 HTTP 适配", () => {
	it.each([
		{ id: "brave_api", method: "GET", headers: { "X-Subscription-Token": "test-key" },
			params: { q: lexicalQuery, count: "20", maximum_number_of_urls: "20", safesearch: "moderate" },
			fields: { snippets: [passage, "Additional excerpt", passage] }, snippet: `${passage}\n\nAdditional excerpt` },
		{ id: "exa_api", method: "POST", headers: { "x-api-key": "test-key", "Exa-Beta": "dynamic-highlights-2026-08-28" },
			params: { query: textQuery, type: "auto", numResults: 20, contents: { highlights: { dynamic: true } }, includeDomains: ["docs.example", "example.com"], excludeDomains: ["blocked.example", "spam.test"] },
			fields: { description: "Page description", highlights: [passage, passage] }, snippet: `Page description\n\n${passage}` },
		{ id: "tavily", method: "POST", headers: { Authorization: "Bearer test-key" },
			params: { query: textQuery, max_results: 20, search_depth: "basic", auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false, include_domains: ["docs.example", "example.com"], exclude_domains: ["blocked.example", "spam.test"] },
			fields: { content: passage }, snippet: passage },
		{ id: "tinyfish", method: "GET", headers: { "X-API-Key": "test-key" },
			params: { query: textQuery, include_domains: "docs.example,example.com", exclude_domains: "blocked.example,spam.test" },
			fields: { snippet: passage }, snippet: passage },
	] as const)("$id 将查询映射到请求，并完整返回片段", async ({ id, method, headers, params, fields, snippet }) => {
		const { config, runtime, fetchImpl } = fixture;
		config.websearch.brave_api.enabled = false;
		Object.assign(config.websearch[id], { enabled: true, api_key: "test-key", max_results: 20 });
		config.websearch.include_domains = ["docs.example"];
		config.websearch.exclude_domains = ["blocked.example"];
		const rows = [{ title: "WidgetError reference", url: "https://example.com/docs", ...fields }];
		fetchImpl.mockResolvedValue(httpResponse(200, JSON.stringify(id === "brave_api" ? { grounding: { generic: rows } } : { results: rows })));
		const result = await runtime.search({ query, limit: 20 }, { toolCallId: id });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const request = fetchImpl.mock.calls[0];
		if (request === undefined) throw new Error("missing HTTP request");
		const [url, init] = request;
		expect(`${url.origin}${url.pathname}`).toBe(new URL(config.websearch[id].endpoint).href);
		expect(init).toMatchObject({ method, headers, redirect: "manual" });
		expect(method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(init.body ?? "null")).toEqual(params);
		expect(result.details).toMatchObject({ status: "success", providers: [id], results: [{ title: "WidgetError reference", snippet }] });
		if (result.details.status !== "success") throw new Error(result.details.error.message);
		expect(result.content).toContain(snippet);
		expect(webSearchStructuredOutput(result.details)).toEqual({ results: [{ title: "WidgetError reference", url: "https://example.com/docs", snippet }] });
	});

	it("Brave 合并网页、地点和地图，按规范化 URL 去重并丢弃无效链接", async () => {
		fixture.fetchImpl.mockResolvedValue(httpResponse(200, JSON.stringify({
			grounding: {
				generic: [
					{ title: "Guide", url: "https://example.com/docs?utm_source=x#top", snippets: ["Guide text"] },
					{ title: "Duplicate", url: "https://example.com/docs" },
					{ title: "Guide", url: "https://example.com/other" },
					{ title: "Invalid", url: "not-a-url" },
					{ title: "Invalid", url: "javascript:alert(1)" },
				],
				poi: { title: "Cafe", url: "https://cafe.test/", snippets: ["Cafe details"] },
				map: [{ title: "Park", url: "https://park.test/", snippets: ["Park details"] }],
			},
			sources: { "https://example.com/docs": { description: "Metadata only" } },
		})));
		await expect(fixture.runtime.search({ query: "local places" }, { toolCallId: "places" })).resolves.toMatchObject({ details: { status: "success", results: [
			{ rank: 1, title: "Guide", url: "https://example.com/docs", snippet: "Guide text" },
			{ rank: 2, title: "Guide", url: "https://example.com/other" },
			{ rank: 3, title: "Cafe", snippet: "Cafe details" },
			{ rank: 4, title: "Park", snippet: "Park details" },
		] } });
	});
});
