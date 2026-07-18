import { describe, expect, it, vi } from "vitest";

import { convertContent } from "../../src/web-tools/content-converter.js";

function headers(contentType: string): Headers {
	return new Headers({ "content-type": contentType });
}

describe("webfetch content conversion", () => {
	it("HTML 清理后转 Markdown，选择 article 并绝对化链接", async () => {
		const html = `
			<html><head><title>Doc</title><script>bad()</script></head>
			<body><nav>nav</nav><article><h1>Title</h1><p>See <a href="/guide">guide</a>.</p>${"x".repeat(220)}</article></body></html>`;
		const result = await convertContent(Buffer.from(html), headers("text/html; charset=utf-8"), "https://example.com/docs/page", "readable");
		expect(result).toMatchObject({ format: "markdown", title: "Doc", charset: "utf-8" });
		if ("status" in result) throw new Error(result.error.message);
		expect(result.text).toContain("# Title");
		expect(result.text).toContain("https://example.com/guide");
		expect(result.text).not.toContain("bad()");
		expect(result.text).not.toContain("nav");
	});

	it("source 模式返回原始解码文本", async () => {
		const loadHtml = vi.fn(async () => {
			throw new Error("HTML converter must remain unloaded");
		});
		const result = await convertContent(Buffer.from("<h1>A</h1>"), headers('text/html; charset="utf-8"'), "https://example.com/", "source", loadHtml);
		expect(result).toMatchObject({ format: "source" });
		expect(loadHtml).not.toHaveBeenCalled();
		if ("status" in result) throw new Error(result.error.message);
		expect(result.text).toBe("<h1>A</h1>");
	});

	it(".html URL 在 readable 模式下即使响应头误报也抽取正文", async () => {
		const html = "<html><head><title>Doc</title></head><body><nav>nav</nav><article><h1>Title</h1><p>Body</p></article></body></html>";
		const textResult = await convertContent(Buffer.from(html), headers("text/plain"), "https://example.com/docs/page.html", "readable");
		expect(textResult).toMatchObject({ format: "markdown", contentType: "text/plain", title: "Doc" });
		if ("status" in textResult) throw new Error(textResult.error.message);
		expect(textResult.text).toContain("# Title");
		expect(textResult.text).not.toContain("<article>");
		expect(textResult.text).not.toContain("nav");

		const binaryResult = await convertContent(Buffer.from(html), headers("application/octet-stream"), "https://example.com/docs/page.html", "readable");
		expect(binaryResult).toMatchObject({ format: "markdown", contentType: "application/octet-stream" });
		if ("status" in binaryResult) throw new Error(binaryResult.error.message);
		expect(binaryResult.text).toContain("Body");
		expect(binaryResult.text).not.toContain("<html>");
	});

	it("JSON/XML/text 不美化，PDF 和 NUL 二进制拒绝", async () => {
		const json = await convertContent(Buffer.from('{"a":1}'), headers("application/json"), "https://example.com/a.json", "readable");
		expect(json).toMatchObject({ format: "json", text: '{"a":1}' });
		const xml = await convertContent(Buffer.from("<x/>"), headers("application/xml"), "https://example.com/a.xml", "readable");
		expect(xml).toMatchObject({ format: "xml", text: "<x/>" });
		expect(await convertContent(Buffer.from("%PDF-1.7"), headers("application/pdf"), "https://example.com/a.pdf", "readable")).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
		expect(await convertContent(Buffer.from([65, 0, 66]), headers("text/plain"), "https://example.com/a.txt", "readable")).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
	});

	it("拒绝非法 Content-Type header", async () => {
		expect(await convertContent(Buffer.from("x"), headers("bad header"), "https://example.com/a.txt", "readable")).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
	});
});
