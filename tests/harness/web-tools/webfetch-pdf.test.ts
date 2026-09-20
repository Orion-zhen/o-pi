import { readFile } from "node:fs/promises";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { executeWebFetch, type ExecuteWebFetchRuntime } from "../../../src/harness/web-tools/fetch/webfetch-tool.ts";
import { SnapshotCache } from "../../../src/harness/web-tools/fetch/snapshot-cache.ts";
import type { WebFetchParams, WebFetchResult } from "../../../src/harness/web-tools/core/types.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { httpResponse, redirectResponse } from "../../helpers/http.ts";

const DOCUMENT_URL = "https://example.com/download";
const dispatchers: Agent[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });

async function fixture(name = "two-page.pdf") {
	return readFile(new URL(`../file-tools/fixtures/read/${name}`, import.meta.url));
}

function runtime(bytes: Uint8Array, contentType = "application/pdf") {
	const dispatcher = new Agent();
	dispatchers.push(dispatcher);
	const requests: string[] = [];
	const rt: ExecuteWebFetchRuntime = {
		dispatcher, config: defaultWebToolsConfig(),
		async fetchImpl(url) { requests.push(url.toString()); return httpResponse(200, bytes, { "content-type": contentType }); },
		cookieStore: { async getCookieAccess() { return {}; }, async storeFromResponse() {} },
		snapshots: new SnapshotCache(), approvedAuthOrigins: new Set(),
		context: { toolCallId: "pdf", acceptsImages: true }, now: () => Date.now(),
	};
	return { rt, requests };
}

function success(result: WebFetchResult) {
	if (result.details.status !== "success") throw new Error(result.details.error.message);
	return result.details;
}

describe("webfetch PDF", () => {
	it.each(["application/pdf", "application/octet-stream", "text/plain"])("根据 MIME 或字节识别无扩展名的 PDF: %s", async (mime) => {
		const { rt } = runtime(await fixture(), mime);
		const result = await executeWebFetch({ url: DOCUMENT_URL }, rt);
		expect(success(result)).toMatchObject({ page_kind: "pdf", text_source: "pdf", format: "text", pdf: { pages: "1-2", total_pages: 2 }, snapshot: "created" });
		expect(result.content).toContain("[page 1]\nPage one");
		expect(result.content).toContain("[page 2]\nPage two");
		expect(result.content).toContain('partial="pdf_text_only"');
		expect(result.media).toBeUndefined();
	});

	it("按页读取、全文查找和按页看图复用同一下载，页面图片携带页码", async () => {
		const { rt, requests } = runtime(await fixture());
		const first = await executeWebFetch({ url: DOCUMENT_URL, pages: "2" }, rt);
		expect(first.content).toContain("Page two");
		expect(first.content).not.toContain("Page one");
		const found = await executeWebFetch({ url: DOCUMENT_URL, find: "ONE" }, rt);
		expect(success(found)).toMatchObject({ snapshot: "hit", range: { kind: "find", matches: 1 } });
		expect(found.content).toContain("[page 1]");
		expect(found.content).toContain("Page one");
		const absent = await executeWebFetch({ url: DOCUMENT_URL, pages: "2", find: "one" }, rt);
		expect(success(absent)).toMatchObject({ snapshot: "hit", range: { matches: 0 } });
		const image = await executeWebFetch({ url: DOCUMENT_URL, mode: "image", pages: "2" }, rt);
		expect(success(image)).toMatchObject({ snapshot: "hit", format: "image", pdf: { pages: "2", total_pages: 2 }, media: { returned: 1 } });
		expect(image.media).toHaveLength(1);
		expect(image.media?.[0]).toMatchObject({ page: 2, mimeType: "image/png" });
		expect(Buffer.from(image.media?.[0]?.data ?? []).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect(requests).toEqual([DOCUMENT_URL]);
	});

	it("离散页排序合并并裁剪结束页，偏移始终相对页选区文本", async () => {
		const { rt } = runtime(await fixture());
		const first = await executeWebFetch({ url: DOCUMENT_URL, pages: "2,1-9,2-" }, rt);
		expect(success(first).pdf?.pages).toBe("1-2");
		expect(first.content.indexOf("Page one")).toBeLessThan(first.content.indexOf("Page two"));
		const second = await executeWebFetch({ url: DOCUMENT_URL, pages: "2", offset: 5 }, rt);
		expect(success(second)).toMatchObject({ snapshot: "hit", range: { start: 5, total: 10 } });
		expect(second.content).toContain("[page 2]\ntwo");
	});

	it("长 PDF 文本续读与多命中续查均返回可直接使用的 offset", async () => {
		const { rt, requests } = runtime(pdfDocument(["A".repeat(1600), "Target", "B".repeat(1600), "Target"]));
		rt.config.webfetch.limits.default_output_chars = 1000;
		rt.config.webfetch.limits.find_max_passages = 1;
		const first = await executeWebFetch({ url: DOCUMENT_URL }, rt);
		const offset = success(first).range.next_offset;
		expect(offset).toBeGreaterThan(0);
		expect(offset).toBeLessThanOrEqual(1000);
		if (offset === undefined) throw new Error("Missing continuation");
		const second = await executeWebFetch({ url: DOCUMENT_URL, offset }, rt);
		expect(success(second)).toMatchObject({ snapshot: "hit", range: { start: offset } });
		expect(second.content).toContain("[page 1]");
		const found = await executeWebFetch({ url: DOCUMENT_URL, find: "Target" }, rt);
		expect(found.content).toContain("[page 2]");
		const next = success(found).range.next_offset;
		expect(next).toBeDefined();
		if (next === undefined) throw new Error("Missing continuation");
		const later = await executeWebFetch({ url: DOCUMENT_URL, find: "Target", offset: next }, rt);
		expect(success(later)).toMatchObject({ range: { matches: 1, has_more: false } });
		expect(later.content).toContain("[page 4]");
		expect(requests).toHaveLength(1);
	});

	it("无文本层不假装完成全文搜索，仍可显式看图", async () => {
		const { rt } = runtime(pdfDocument([""]));
		const result = await executeWebFetch({ url: DOCUMENT_URL, find: "target" }, rt);
		expect(success(result)).toMatchObject({ completeness: "partial", omissions: [{ reason: "no_text_layer" }], range: { matches: 0 } });
		expect(result.content).toContain('Use mode="image"');
		const image = await executeWebFetch({ url: DOCUMENT_URL, mode: "image" }, rt);
		expect(success(image)).toMatchObject({ snapshot: "hit", completeness: "complete", media: { returned: 1 } });
	});

	it("图片页数受限，next_pages 可继续且不重新下载", async () => {
		const { rt, requests } = runtime(pdfDocument(Array.from({ length: 22 }, () => "")));
		const first = await executeWebFetch({ url: DOCUMENT_URL, mode: "image" }, rt);
		expect(success(first)).toMatchObject({ pdf: { pages: "1-20", next_pages: "21-22", total_pages: 22 }, media: { returned: 20 } });
		const pages = success(first).pdf?.next_pages;
		if (pages === undefined) throw new Error("Missing page continuation");
		const second = await executeWebFetch({ url: DOCUMENT_URL, mode: "image", pages }, rt);
		expect(success(second)).toMatchObject({ snapshot: "hit", pdf: { pages: "21-22" }, media: { returned: 2 } });
		expect(success(second).pdf).not.toHaveProperty("next_pages");
		expect(requests).toHaveLength(1);
	});

	it("文本解析页数受限，选页后仍可读取大文档", async () => {
		const { rt } = runtime(pdfDocument(Array.from({ length: 501 }, () => "Page")));
		const first = await executeWebFetch({ url: DOCUMENT_URL }, rt);
		expect(first.details).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } });
		const selected = await executeWebFetch({ url: DOCUMENT_URL, pages: "501" }, rt);
		expect(success(selected).pdf).toMatchObject({ pages: "501", total_pages: 501 });
	});

	it.each(["3", "2-1", "9007199254740992"])("拒绝不可用页范围: %s", async (pages) => {
		const { rt } = runtime(await fixture());
		const result = await executeWebFetch({ url: DOCUMENT_URL, pages }, rt);
		expect(result.details).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } });
	});

	it.each([
		{ mode: "image", find: "one" }, { mode: "image", offset: 0 },
	] satisfies Partial<WebFetchParams>[]) ("图片模式与文本参数互斥: %j", async (params) => {
		const { rt, requests } = runtime(await fixture());
		const result = await executeWebFetch({ url: DOCUMENT_URL, ...params }, rt);
		expect(result.details).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } });
		expect(requests).toHaveLength(0);
	});

	it("PDF 拒绝 source 和 URL fragment", async () => {
		const { rt } = runtime(await fixture());
		expect((await executeWebFetch({ url: DOCUMENT_URL, mode: "source" }, rt)).details).toMatchObject({ error: { code: "UNSUPPORTED_CONTENT_TYPE" } });
		expect((await executeWebFetch({ url: `${DOCUMENT_URL}#page=2` }, rt)).details).toMatchObject({ error: { code: "ANCHOR_NOT_FOUND" } });
	});

	it("非 PDF 不接受 pages，纯文本不提供 image 输出", async () => {
		const { rt } = runtime(Buffer.from("A web page"), "text/plain");
		expect((await executeWebFetch({ url: DOCUMENT_URL, pages: "1" }, rt)).details).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
		expect((await executeWebFetch({ url: DOCUMENT_URL, mode: "image" }, rt)).details).toMatchObject({ error: { code: "UNSUPPORTED_CONTENT_TYPE" } });
	});

	it("模型无视觉能力或用户关闭媒体时拒绝图片模式，文本仍可读", async () => {
		const { rt } = runtime(await fixture());
		rt.context.acceptsImages = false;
		expect((await executeWebFetch({ url: DOCUMENT_URL, mode: "image" }, rt)).details).toMatchObject({ error: { code: "UNSUPPORTED_CONTENT_TYPE" } });
		rt.context.acceptsImages = true;
		rt.config.webfetch.media.mode = "off";
		expect((await executeWebFetch({ url: DOCUMENT_URL, mode: "image" }, rt)).details).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
		expect(success(await executeWebFetch({ url: DOCUMENT_URL }, rt)).format).toBe("text");
	});

	it("密码保护和损坏文档返回结构化解析错误", async () => {
		for (const bytes of [await fixture("password.pdf"), Buffer.from("%PDF-1.7\ninvalid")]) {
			const { rt } = runtime(bytes);
			expect((await executeWebFetch({ url: DOCUMENT_URL }, rt)).details).toMatchObject({ status: "failed", error: { code: "CONVERSION_FAILED" } });
		}
	});

	it("转换前取消与缓存命中后取消均不返回 PDF 内容", async () => {
		const { rt } = runtime(await fixture());
		await executeWebFetch({ url: DOCUMENT_URL }, rt);
		rt.context.signal = AbortSignal.abort();
		expect((await executeWebFetch({ url: DOCUMENT_URL, pages: "1" }, rt)).details).toMatchObject({ error: { code: "ABORTED" } });
		const controller = new AbortController();
		rt.context.signal = controller.signal;
		rt.context.onUpdate = (update) => { if (update.details.phase === "converting") controller.abort(); };
		expect((await executeWebFetch({ url: DOCUMENT_URL }, rt)).details).toMatchObject({ error: { code: "ABORTED" } });
	});

	it("PDF 下载仍服从响应大小限制和重定向访问限制", async () => {
		const { rt } = runtime(Buffer.concat([await fixture(), Buffer.alloc(65536, 32)]));
		rt.config.webfetch.limits.response_bytes = 65536;
		expect((await executeWebFetch({ url: DOCUMENT_URL }, rt)).details).toMatchObject({ error: { code: "RESPONSE_TOO_LARGE" } });
		rt.fetchImpl = async () => redirectResponse("http://127.0.0.1/document.pdf");
		expect((await executeWebFetch({ url: DOCUMENT_URL }, rt)).details).toMatchObject({ error: { code: "BLOCKED_ADDRESS" } });
	});

	it("快照过期后重新下载，普通无选区读取也刷新文档", async () => {
		const { rt, requests } = runtime(await fixture());
		let now = 0;
		rt.snapshots = new SnapshotCache(() => now);
		await executeWebFetch({ url: DOCUMENT_URL }, rt);
		await executeWebFetch({ url: DOCUMENT_URL, pages: "1" }, rt);
		expect(requests).toHaveLength(1);
		now = 10 * 60 * 1000 + 1;
		await executeWebFetch({ url: DOCUMENT_URL, pages: "1" }, rt);
		expect(requests).toHaveLength(2);
		await executeWebFetch({ url: DOCUMENT_URL }, rt);
		expect(requests).toHaveLength(3);
	});
});

/** 生成有真实页树、内容流和交叉引用表的 PDF，覆盖空页、长文本和多页文档。 */
function pdfDocument(texts: string[]): Buffer {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	const kids: string[] = [];
	for (const text of texts) {
		const number = objects.length + 1;
		kids.push(`${number} 0 R`);
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${number + 1} 0 R >>`);
		const lines = text.match(/.{1,80}/g) ?? [""];
		const stream = `BT /F1 1 Tf 2 TL 0 95 Td ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
		objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	}
	objects[1] = `<< /Type /Pages /Count ${texts.length} /Kids [${kids.join(" ")}] >>`;
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}
