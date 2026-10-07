import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { searchApiProvider, type ApiProviderOptions } from "../../../src/harness/web-tools/search-providers/api-provider.ts";
import { SearchProviderRouter } from "../../../src/harness/web-tools/search-providers/router.ts";
import { executeWebSearch } from "../../../src/harness/web-tools/search/websearch-tool.ts";
import { SearchFlights } from "../../../src/harness/web-tools/search/search-flights.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { httpResponse } from "../../helpers/http.ts";

const dispatchers: Agent[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });

const QUERY = '"WidgetError" v2.4';
const EXACT = "WidgetError in v2.4 requires an explicit timeout.";
const INTRO = "General product introduction without the requested details. ".repeat(15);

async function search(id: ApiProviderOptions["id"], fields: Record<string, unknown>, query = QUERY) {
	const config = defaultWebToolsConfig();
	const dispatcher = new Agent();
	dispatchers.push(dispatcher);
	let requests = 0;
	const row = { title: "WidgetError v2.4 reference", url: "https://example.com/docs", ...fields };
	const fetchImpl = async () => {
		requests += 1;
		return httpResponse(200, JSON.stringify(id === "brave_api" ? { web: { results: [row] } } : id === "anysearch" ? { code: 0, data: { results: [row] } } : { results: [row] }), { "content-type": "application/json" });
	};
	const transport = { key: "test-key", dispatcher: async () => dispatcher, fetchImpl };
	const options = id === "brave_api" ? { ...transport, id, config: config.websearch.brave_api }
		: id === "exa_api" ? { ...transport, id, config: config.websearch.exa_api }
		: id === "tavily" ? { ...transport, id, config: config.websearch.tavily }
		: id === "tinyfish" ? { ...transport, id, config: config.websearch.tinyfish }
		: { ...transport, id, config: config.websearch.anysearch };
	const result = await executeWebSearch({ query, limit: 1 }, {
		config, searches: new SearchFlights(),
		router: new SearchProviderRouter({ primary: [{ id, maxResults: 5, search: (params, context) => searchApiProvider(options, params, context) }], auxiliary: [] }),
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
		["tinyfish", { snippet: `${INTRO}${EXACT} ${INTRO}` }],
		["anysearch", { content: `${INTRO}${EXACT} ${INTRO}`, snippet: INTRO }],
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
});
