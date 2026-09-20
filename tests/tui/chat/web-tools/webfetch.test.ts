import { describe, expect, it } from "vitest";

import { formatWebFetchCall, formatWebFetchResult, renderWebFetchCall, renderWebFetchResult } from "../../../../src/tui/chat/web-tools/webfetch.ts";
import { expectRendererLifecycle, theme, webFetchDetails } from "./fixtures.ts";


describe("webfetch renderer", () => {
	it("残缺参数不崩溃，且 URL query 不泄漏", () => {
		expect(formatWebFetchCall({}, theme).length).toBeGreaterThan(0);
		const text = formatWebFetchCall({ url: "https://example.com/path?token=abc&q=x", mode: "source", offset: 20000 }, theme);
		for (const value of ["example.com/path", "source", "20000"]) expect(text).toContain(value);
		expect(text).not.toContain("abc");
	});

	it("折叠隐藏预览，展开后保留响应信息，并安全渲染进度与失败", () => {
		const details = webFetchDetails();
		const collapsed = formatWebFetchResult(details, {}, theme);
		const expanded = formatWebFetchResult(details, { expanded: true }, theme);
		expect(collapsed).not.toContain(details.preview);
		for (const value of ["Example article", details.final_url, details.preview, "iframe_not_fetched"]) {
			expect(expanded).toContain(value);
		}
		expect(expanded.length).toBeGreaterThan(collapsed.length);

		for (const progress of [
			{ status: "progress", phase: "requesting" },
			{ status: "progress", phase: "redirecting" },
			{ status: "progress", phase: "downloading", received_bytes: 2048 },
			{ status: "progress", phase: "converting" },
		] as const) {
			expect(formatWebFetchResult(progress, { isPartial: true }, theme).length).toBeGreaterThan(0);
		}
		const failure = formatWebFetchResult(
			{ status: "failed", error: { code: "BLOCKED_ADDRESS", message: "private network address" }, duration_ms: 1 },
			{ expanded: true },
			theme,
		);
		for (const value of ["BLOCKED_ADDRESS", "private network address"]) expect(failure).toContain(value);
	});

	it("find 呈现命中数和片段预览，不把离散片段展示成整段读取", () => {
		const details = webFetchDetails({
			range: { kind: "find", start: 100, total: 3000, matches: 2, passages: [{ start: 110, end: 160 }], has_more: false },
			preview: "[110-160]\nMatching excerpt.",
			media: { discovered: 1, returned: 0 },
		});
		const call = formatWebFetchCall({ url: "https://example.com/page", find: "lookup", offset: 100 }, theme);
		expect(call).toContain("find");
		expect(call).toContain("from 100");
		expect(call).not.toContain("100-150");
		const collapsed = formatWebFetchResult(details, {}, theme);
		expect(collapsed).toContain("2 matches, 1 excerpts");
		expect(collapsed).not.toContain("Matching excerpt");
		const expanded = formatWebFetchResult(details, { expanded: true }, theme);
		expect(expanded).toContain("find from 100 of 3000");
		expect(expanded).toContain("[110-160]");
		expect(expanded).toContain("Matching excerpt.");
	});

	it("PDF 调用和结果显示页范围与继续页，不将图片页显示成字符偏移", () => {
		const call = formatWebFetchCall({ url: "https://example.com/report.pdf", mode: "image", pages: "2-4" }, theme);
		expect(call).toContain("image");
		expect(call).toContain("pages 2-4");
		expect(call).not.toContain("offset");
		const details = webFetchDetails({ page_kind: "pdf", text_source: "metadata", format: "image", completeness: "complete", omissions: [], pdf: { pages: "1-20", total_pages: 22, next_pages: "21-22" }, media: { discovered: 22, returned: 20 } });
		const result = formatWebFetchResult(details, {}, theme);
		expect(result).toContain("pages 1-20/22");
		expect(result).toContain("more");
		expect(result).toContain("20 image");
		const textResult = formatWebFetchResult(webFetchDetails({ page_kind: "pdf", text_source: "pdf", format: "text", pdf: { pages: "2", total_pages: 22 } }), { expanded: true }, theme);
		expect(textResult).toContain("pages 2/22");
	});

	it("progress 和最终结果接管调用阶段组件", () => {
		const args = { url: "https://example.com/page", mode: "readable" };
		expectRendererLifecycle({
			createState: () => ({}),
			renderCall: (lastComponent, state) => renderWebFetchCall(args, theme, { lastComponent, state }),
			renderProgress: (lastComponent, state) => renderWebFetchResult(
				{ details: { status: "progress", phase: "requesting" } },
				{ isPartial: true },
				theme,
				{ args, lastComponent, state },
			),
			renderSettled: (lastComponent, state) => renderWebFetchResult(
				{ details: { status: "failed", requested_url: args.url, error: { code: "TIMEOUT", message: "deadline exceeded" } } },
				{ isPartial: false },
				theme,
				{ args, lastComponent, state },
			),
			initialContains: ["example.com/page"],
			progressContains: ["example.com/page"],
			settledContains: ["deadline exceeded"],
		});
	});
});
