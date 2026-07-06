import { describe, expect, it } from "vitest";

import { convertContent } from "../../src/web-tools/content-converter.js";

function headers(contentType: string): Headers {
	return new Headers({ "content-type": contentType });
}

describe("webfetch content conversion", () => {
	it("HTML 清理后转 Markdown，选择 article 并绝对化链接", () => {
		const html = `
			<html><head><title>Doc</title><script>bad()</script></head>
			<body><nav>nav</nav><article><h1>Title</h1><p>See <a href="/guide">guide</a>.</p>${"x".repeat(220)}</article></body></html>`;
		const result = convertContent(Buffer.from(html), headers("text/html; charset=utf-8"), "https://example.com/docs/page", "readable");
		expect(result).toMatchObject({ format: "markdown", title: "Doc", charset: "utf-8" });
		if ("status" in result) throw new Error(result.error.message);
		expect(result.text).toContain("# Title");
		expect(result.text).toContain("https://example.com/guide");
		expect(result.text).not.toContain("bad()");
		expect(result.text).not.toContain("nav");
	});

	it("source 模式返回原始解码文本", () => {
		const result = convertContent(Buffer.from("<h1>A</h1>"), headers('text/html; charset="utf-8"'), "https://example.com/", "source");
		expect(result).toMatchObject({ format: "source" });
		if ("status" in result) throw new Error(result.error.message);
		expect(result.text).toBe("<h1>A</h1>");
	});

	it("JSON/XML/text 不美化，PDF 和 NUL 二进制拒绝", () => {
		const json = convertContent(Buffer.from('{"a":1}'), headers("application/json"), "https://example.com/a.json", "readable");
		expect(json).toMatchObject({ format: "json", text: '{"a":1}' });
		const xml = convertContent(Buffer.from("<x/>"), headers("application/xml"), "https://example.com/a.xml", "readable");
		expect(xml).toMatchObject({ format: "xml", text: "<x/>" });
		expect(convertContent(Buffer.from("%PDF-1.7"), headers("application/pdf"), "https://example.com/a.pdf", "readable")).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
		expect(convertContent(Buffer.from([65, 0, 66]), headers("text/plain"), "https://example.com/a.txt", "readable")).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
	});

	it("拒绝非法 Content-Type header", () => {
		expect(convertContent(Buffer.from("x"), headers("bad header"), "https://example.com/a.txt", "readable")).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
	});
});
