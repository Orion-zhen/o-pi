import { describe, expect, it } from "vitest";

import { webSearchStructuredOutput } from "../../../src/harness/web-tools/search/structured-output.ts";
import { httpResponse } from "../../helpers/http.ts";
import { useWebSearch } from "./search-fixture.ts";

const fixture = useWebSearch();

describe("websearch 输出", () => {
	it("配置与查询的域名冲突在请求前返回 INVALID_ARGUMENT", async () => {
		fixture.config.websearch.exclude_domains = ["example.com"];
		await expect(fixture.runtime.search({ query: "site:example.com pi" }, { toolCallId: "conflict" }))
			.resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		expect(fixture.fetchImpl).not.toHaveBeenCalled();
	});

	it("模型正文转义 XML、清理终端控制字符，结构化结果保留原始排版", async () => {
		fixture.config.websearch.default_results = 2;
		const title = "😀 <Title>& ".repeat(50).trim();
		const snippet = "<code>\n  x && y\n\treturn '中文';\n</code>\n".repeat(100);
		fixture.fetchImpl.mockResolvedValue(httpResponse(200, JSON.stringify({ grounding: { generic: [
			{ title, url: "https://example.com/?a=1", snippets: [`\u001b[31m${snippet}\u001b[0m\u0000`] },
			{ title: "Second", url: "https://example.org/" },
		] } })));
		const result = await fixture.runtime.search({ query: "pi docs" }, { toolCallId: "output" });
		expect(result.details).toMatchObject({ status: "success", providers: ["brave_api"] });
		expect(result.content).toBe([
			"<websearch>", `[1] ${"😀 &lt;Title&gt;&amp; ".repeat(50).trim()}`, "https://example.com/?a=1",
			"&lt;code&gt;\n  x &amp;&amp; y\n\treturn '中文';\n&lt;/code&gt;\n".repeat(100),
			"", "[2] Second", "https://example.org/", "</websearch>",
		].join("\n"));
		if (result.details.status !== "success") throw new Error(result.details.error.message);
		expect(webSearchStructuredOutput(result.details)).toEqual({ results: [
			{ title, url: "https://example.com/?a=1", snippet },
			{ title: "Second", url: "https://example.org/" },
		] });
		expect(fixture.fetchImpl).toHaveBeenCalledOnce();
	});

	it("HTTP 失败的模型正文不暴露响应内容和尝试记录", async () => {
		fixture.fetchImpl.mockResolvedValue(httpResponse(503, "private upstream diagnostic"));
		const result = await fixture.runtime.search({ query: "pi" }, { toolCallId: "failure" });
		expect(result.details).toMatchObject({ status: "failed", provider: "brave_api", query: "pi", http_status: 503,
			duration_ms: expect.any(Number), attempts: [
				{ provider: "brave_api", role: "primary", status: "failed", duration_ms: expect.any(Number), error: { code: "HTTP_ERROR" }, http_status: 503 },
			],
		});
		expect(result.content).toBe('<error tool="websearch" code="HTTP_ERROR">\n503 search provider HTTP error.\n</error>');
		expect(JSON.stringify(result)).not.toContain("private upstream diagnostic");
	});
});
