import { describe, expect, it } from "vitest";

import { formatWebFetchCall, formatWebFetchResult, renderWebFetchCall, renderWebFetchResult } from "../../src/web-tools/tui/webfetch.js";
import { expectRendererLifecycle, theme, webFetchDetails } from "./renderer-fixture.js";


describe("webfetch renderer", () => {
	it("残缺参数不崩溃，且 URL query 不泄漏", () => {
		expect(formatWebFetchCall({}, theme).length).toBeGreaterThan(0);
		const text = formatWebFetchCall({ url: "https://example.com/path?token=abc&q=x", mode: "source", offset: 20000, limit: 20000 }, theme);
		for (const value of ["example.com/path", "source", "20000", "40000"]) expect(text).toContain(value);
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
		const call = formatWebFetchCall({ url: "https://example.com/page", find: "lookup", offset: 100, limit: 50 }, theme);
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
