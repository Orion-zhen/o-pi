import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeSearchText, parseDuckDuckGoHtml, unwrapDuckDuckGoUrl } from "../../src/web-tools/duckduckgo-html.js";

const fixtureDir = path.join(process.cwd(), "tests", "web-tools", "fixtures", "websearch");

async function fixture(name: string): Promise<string> {
	return readFile(path.join(fixtureDir, name), "utf8");
}

describe("websearch parser", () => {
	it("提取标题、摘要和解包后的安全 URL，并丢弃广告、重复和非法协议", async () => {
		const parsed = parseDuckDuckGoHtml(await fixture("results.html"));
		expect(parsed.status).toBe("success");
		if (parsed.status !== "success") throw new Error("parse failed");
		expect(parsed.results).toEqual([
			{
				rank: 1,
				title: "Example Page",
				url: "https://example.com/page?a=1",
				snippet: "First snippet with extra spacing.",
			},
			{
				rank: 2,
				title: "Pi Coding Agent",
				url: "https://github.com/earendil-works/pi",
				snippet: "Extensible coding agent harness.",
			},
		]);
	});

	it("处理协议相对链接、普通绝对链接、fragment 和追踪参数", () => {
		expect(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Futm_medium%3Dx%26ok%3D1%23frag")?.toString()).toBe("https://example.com/a?ok=1");
		expect(unwrapDuckDuckGoUrl("https://example.com/a?gclid=x&ok=1#frag")?.toString()).toBe("https://example.com/a?ok=1");
		expect(unwrapDuckDuckGoUrl("ftp://example.com/file")).toBeUndefined();
	});

	it("识别合法零结果、challenge 和未知结构", async () => {
		expect(parseDuckDuckGoHtml(await fixture("no-results.html"))).toEqual({ status: "success", results: [] });
		expect(parseDuckDuckGoHtml(await fixture("challenge.html"))).toMatchObject({ status: "failed", code: "PROVIDER_BLOCKED" });
		expect(parseDuckDuckGoHtml(await fixture("changed-markup.html"))).toMatchObject({ status: "failed", code: "PARSE_FAILED" });
	});

	it("清理摘要中的控制字符", () => {
		expect(normalizeSearchText("Hello\u001b[31m red\u001b[0m\u0000\nworld")).toBe("Hello red world");
	});
});
