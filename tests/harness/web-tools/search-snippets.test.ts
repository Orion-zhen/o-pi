import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { searchApiProvider, type ApiProviderOptions } from "../../../src/harness/web-tools/search-providers/api-provider.ts";
import { SearchProviderRouter } from "../../../src/harness/web-tools/search-providers/router.ts";
import { executeWebSearch } from "../../../src/harness/web-tools/search/websearch-tool.ts";
import { webSearchStructuredOutput } from "../../../src/harness/web-tools/search/structured-output.ts";
import { SearchFlights } from "../../../src/harness/web-tools/search/search-flights.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { httpResponse } from "../../helpers/http.ts";

const dispatchers: Agent[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });

const QUERY = '"WidgetError" v2.4';
const EXACT = "WidgetError in v2.4 requires an explicit timeout.";
const INTRO = "General product introduction without the requested details. ".repeat(30);

async function search(id: ApiProviderOptions["id"], fields: Record<string, unknown>, query = QUERY) {
	const config = defaultWebToolsConfig();
	const dispatcher = new Agent();
	dispatchers.push(dispatcher);
	let requests = 0;
	const row = { title: "WidgetError v2.4 reference", url: "https://example.com/docs", ...fields };
	const fetchImpl = async () => {
		requests += 1;
		return httpResponse(200, JSON.stringify(id === "brave_api" ? { grounding: { generic: [row] } } : id === "anysearch" ? { code: 0, data: { results: [row] } } : { results: [row] }), { "content-type": "application/json" });
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

describe("搜索内容完整保留", () => {
	it.each([
		["brave_api", { snippets: [INTRO, EXACT, EXACT] }, `${INTRO}\n\n${EXACT}`],
		["exa_api", { description: "Page description", highlights: [INTRO, EXACT, EXACT] }, `Page description\n\n${INTRO}\n\n${EXACT}`],
		["tavily", { content: `${INTRO}${EXACT} ${INTRO}` }, `${INTRO}${EXACT} ${INTRO}`],
		["tinyfish", { snippet: `${INTRO}${EXACT} ${INTRO}` }, `${INTRO}${EXACT} ${INTRO}`],
		["anysearch", { content: `${INTRO}${EXACT} ${INTRO}`, snippet: "Additional excerpt" }, `${INTRO}${EXACT} ${INTRO}\n\nAdditional excerpt`],
	] as const)("%s 的全部非空片段进入模型正文和结构化结果，不按查询选片或截断", async (id, fields, expected) => {
		const result = await search(id, fields);
		expect(result.details.results[0]?.snippet).toBe(expected);
		expect(result.content).toContain(expected);
		expect(webSearchStructuredOutput(result.details).results[0]?.snippet).toBe(expected);
		expect(result.requests).toBe(1);
	});

	it("查询不改变片段顺序，只去除完全重复和无效片段", async () => {
		const snippets = ["First unrelated passage.", null, 42, "", " \n\t", EXACT, EXACT, "Last unrelated passage."];
		const first = await search("brave_api", { snippets });
		const second = await search("brave_api", { snippets }, "site:example.com unrelated");
		const expected = `First unrelated passage.\n\n${EXACT}\n\nLast unrelated passage.`;
		expect(first.details.results[0]?.snippet).toBe(expected);
		expect(second.details.results[0]?.snippet).toBe(expected);
	});

	it("保留代码缩进、换行、表格和 Unicode，只清理终端控制字符", async () => {
		const code = "  function example() {\n\treturn '😀 中文';\n  }\r\n";
		const table = "| Name | Value |\n| --- | --- |\n| pi | 3.14 |";
		const result = await search("brave_api", { snippets: [`\u001b[31m${code}\u001b[0m\u0000`, table] });
		const expected = `${code}\n\n${table}`;
		expect(result.details.results[0]?.snippet).toBe(expected);
		expect(result.content).toContain(expected);
	});

	it("长标题和含 XML 字符的长内容完整进入模型正文", async () => {
		const title = "😀 documentation ".repeat(50);
		const text = "<code>\n  x && y\n</code>\n".repeat(100);
		const result = await search("exa_api", { title, highlights: [text] });
		expect(result.details.results[0]?.title).toBe(title.trim());
		expect(result.content).toContain(title.trim());
		expect(result.details.results[0]?.snippet).toBe(text);
		expect(result.content).toContain("&lt;code&gt;\n  x &amp;&amp; y\n&lt;/code&gt;\n".repeat(100));
	});
});
