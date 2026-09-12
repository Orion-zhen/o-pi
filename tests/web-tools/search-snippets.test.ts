import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { searchApiProvider } from "../../src/web-tools/search-providers/api-provider.js";
import { SearchProviderRouter } from "../../src/web-tools/search-providers/router.js";
import { mergeSearchResults } from "../../src/web-tools/search-providers/merge.js";
import { compileSearchQuery } from "../../src/web-tools/search-providers/query.js";
import { searchDuckDuckGoHtml } from "../../src/web-tools/search/duckduckgo-html.js";
import { executeWebSearch } from "../../src/web-tools/search/websearch-tool.js";
import { SearchFlights } from "../../src/web-tools/search/search-flights.js";
import type { FormalWebSearchProviderId } from "../../src/web-tools/core/types.js";
import { defaultWebToolsConfig } from "./config-fixture.js";
import { httpResponse } from "../helpers/http.js";

const dispatchers: Agent[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });

const QUERY = '"WidgetError" v2.4';
const EXACT = "WidgetError in v2.4 requires an explicit timeout.";
const INTRO = "General product introduction without the requested details. ".repeat(15);

async function search(id: FormalWebSearchProviderId, fields: Record<string, unknown>, query = QUERY) {
	const config = defaultWebToolsConfig();
	const dispatcher = new Agent();
	dispatchers.push(dispatcher);
	let requests = 0;
	const row = { title: "WidgetError v2.4 reference", url: "https://example.com/docs", ...fields };
	const fetchImpl = async () => {
		requests += 1;
		return httpResponse(200, JSON.stringify(id === "brave_api" ? { web: { results: [row] } } : { results: [row] }), { "content-type": "application/json" });
	};
	const transport = { key: "test-key", dispatcher: async () => dispatcher, fetchImpl };
	const options = id === "brave_api" ? { ...transport, id, config: config.websearch.brave_api }
		: id === "exa_api" ? { ...transport, id, config: config.websearch.exa_api }
		: { ...transport, id, config: config.websearch.tavily };
	const result = await executeWebSearch({ query, limit: 1 }, {
		config, searches: new SearchFlights(),
		router: new SearchProviderRouter([{ id, search: (params, context) => searchApiProvider(options, params, context) }]),
		context: { toolCallId: "snippet" }, now: () => Date.now(),
	});
	if (result.details.status !== "success") throw new Error(result.details.error.message);
	return { ...result, details: result.details, requests };
}

describe("搜索摘要按查询选片", () => {
	it.each([
		["brave_api", { description: INTRO, extra_snippets: [INTRO, EXACT, EXACT] }],
		["exa_api", { highlights: [INTRO, EXACT, EXACT] }],
		["tavily", { content: `${INTRO}${EXACT} ${INTRO}` }],
	] as const)("%s 从已返回原文中保留错误码和版本，输出不超过 240 字符", async (id, fields) => {
		const result = await search(id, fields);
		const snippet = result.details.results[0]?.snippet;
		expect(snippet).toContain(EXACT);
		expect(snippet?.length).toBeLessThanOrEqual(240);
		expect(snippet?.split(EXACT)).toHaveLength(2);
		expect(result.content).toContain(EXACT);
		expect(result.requests).toBe(1);
	});

	it("优先保留精确短语而不是重复的普通查询词", async () => {
		const result = await search("brave_api", {
			description: "timeout guide ".repeat(40),
			extra_snippets: ["The exact failure text identifies an incompatible request."],
		}, '"exact failure text" timeout guide');
		expect(result.details.results[0]?.snippet).toBe("The exact failure text identifies an incompatible request.");
	});

	it("精确版本不命中较长版本号，错误码也不命中其他标识符的子串", async () => {
		const result = await search("brave_api", {
			description: "OtherWidgetError in v2.40 uses the unrelated behavior.",
			extra_snippets: [EXACT],
		});
		expect(result.details.results[0]?.snippet).toBe(EXACT);
	});

	it("不把域名操作符当正文关键词，无命中时保留首段并安全截断 Unicode", async () => {
		const result = await search("brave_api", {
			description: `${"😀".repeat(130)} documentation`,
			extra_snippets: ["example.com example.com should not win as a query term."],
		}, "site:example.com unrelated");
		const snippet = result.details.results[0]?.snippet;
		expect(snippet).toMatch(/^😀/u);
		expect(snippet?.length).toBeLessThanOrEqual(240);
		expect(snippet).not.toMatch(/[\uD800-\uDFFF]/u);
	});

	it("DDG 也在截断前寻找查询词附近的摘要", async () => {
		const dispatcher = new Agent();
		dispatchers.push(dispatcher);
		const result = await searchDuckDuckGoHtml({
			query: QUERY, limit: 1, config: defaultWebToolsConfig().websearch.duckduckgo_html,
			dispatcher, signal: new AbortController().signal,
			fetchImpl: async () => httpResponse(200, `<div class="result"><a class="result__a" href="https://example.com/docs">Guide</a><span class="result__snippet">${INTRO}${EXACT}</span></div>`, { "content-type": "text/html" }),
		});
		expect(result.status).toBe("success");
		if (result.status !== "success") throw new Error("failed");
		expect(result.results[0]?.snippet).toContain(EXACT);
		expect(result.results[0]?.snippet?.length).toBeLessThanOrEqual(240);
	});

	it("跨来源合并保留相关片段，不再单纯选较长摘要", () => {
		const merged = mergeSearchResults([
			{ provider: "brave_api", weight: 1, results: [{ rank: 1, title: "Guide", url: "https://example.com/docs", snippet: EXACT }] },
			{ provider: "tavily", weight: 0.9, results: [{ rank: 1, title: "Guide", url: "https://example.com/docs", snippet: INTRO.slice(0, 200) }] },
		], 1, compileSearchQuery({ query: QUERY }));
		expect(merged[0]?.snippet).toBe(EXACT);
	});
});
