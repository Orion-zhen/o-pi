import { describe, expect, it } from "vitest";

import type { WebFetchSuccessDetails } from "../../src/web-tools/core/types.js";
import { formatWebFetchCall, formatWebFetchResult, renderWebFetchCall, renderWebFetchResult } from "../../src/web-tools/tui/webfetch.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("webfetch renderer", () => {
	it("残缺参数不崩溃，且 URL query 不泄漏", () => {
		expect(formatWebFetchCall({}, theme).length).toBeGreaterThan(0);
		const text = formatWebFetchCall({ url: "https://example.com/path?token=abc&q=x", mode: "source", offset: 20000, limit: 20000 }, theme);
		for (const value of ["example.com/path", "source", "20000", "40000"]) expect(text).toContain(value);
		expect(text).not.toContain("abc");
	});

	it("折叠隐藏预览，展开后保留响应信息，并安全渲染进度与失败", () => {
		const details = successDetails();
		const collapsed = formatWebFetchResult(details, {}, theme);
		const expanded = formatWebFetchResult(details, { expanded: true }, theme);
		expect(collapsed).not.toContain(details.preview);
		for (const value of ["Example article", details.final_url, details.preview, "text_range"]) {
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

	it("progress 和最终结果接管调用阶段组件", () => {
		const args = { url: "https://example.com/page", mode: "readable" };
		const state = {};
		let call = renderWebFetchCall(args, theme, { lastComponent: undefined, state });
		expect(call.render(160).join("")).toContain("example.com/page");

		call = renderWebFetchCall(args, theme, { lastComponent: call, state });
		let result = renderWebFetchResult(
			{ details: { status: "progress", phase: "requesting" } },
			{ isPartial: true },
			theme,
			{ args, lastComponent: undefined, state },
		);
		expect(call.render(160).join("")).toBe("");
		expect(result.render(160).join("")).toContain("example.com/page");

		call = renderWebFetchCall(args, theme, { lastComponent: call, state });
		result = renderWebFetchResult(
			{ details: { status: "failed", requested_url: args.url, error: { code: "TIMEOUT", message: "deadline exceeded" } } },
			{ isPartial: false },
			theme,
			{ args, lastComponent: result, state },
		);
		expect(call.render(160).join("")).toBe("");
		expect(result.render(160).join("")).toContain("deadline exceeded");
	});
});

function successDetails(): WebFetchSuccessDetails {
	return {
		status: "success",
		scope: "static_response",
		page_kind: "article",
		text_source: "readability",
		completeness: "partial",
		omissions: [{ kind: "text_range", reason: "range" }],
		requested_url: "https://example.com/start",
		final_url: "https://example.com/final",
		http_status: 200,
		title: "Example article",
		content_type: "text/html",
		charset: "utf-8",
		format: "markdown",
		downloaded_bytes: 100,
		total_chars: 3000,
		range: { start: 0, end: 1000, total: 3000, has_more: true, next_offset: 1000 },
		authenticated: true,
		redirect_count: 1,
		snapshot: "created",
		deferred_fragments: { discovered: 1, resolved: 1, limited: false },
		media: { discovered: 1, returned: 1 },
		duration_ms: 12,
		preview: "preview sentinel",
	};
}
