import { describe, expect, it } from "vitest";

import { formatWebFetchCall, formatWebFetchResult, renderWebFetchCall, renderWebFetchResult } from "../../src/web-tools/webfetch-renderer.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("webfetch renderer", () => {
	it("残缺 args 不崩溃，URL query 折叠并显示 source/offset", () => {
		expect(formatWebFetchCall({}, theme)).toContain("...");
		const text = formatWebFetchCall({ url: "https://example.com/path?token=abc&q=x", mode: "source", offset: 20000, limit: 20000 }, theme);
		expect(text).toContain("example.com/path?...");
		expect(text).toContain("source");
		expect(text).toContain("offset 20000-40000");
		expect(text).not.toContain("abc");
		expect(text.split("\n")).toHaveLength(2);
	});

	it("渲染 success、progress 和 failure", () => {
		expect(formatWebFetchResult({ status: "progress", phase: "downloading", received_bytes: 2048 }, { isPartial: true }, theme)).toContain("2.0 KB");
		const success = formatWebFetchResult(
			{
				status: "success",
				requested_url: "https://example.com/",
				final_url: "https://example.com/",
				http_status: 200,
				format: "markdown",
				downloaded_bytes: 100,
				total_chars: 3000,
				range: { start: 0, end: 1000, total: 3000, has_more: true, next_offset: 1000 },
				next: "Call webfetch with the same url and mode, offset 1000.",
				authenticated: true,
				redirect_count: 1,
				snapshot: "created",
				duration_ms: 12,
				preview: "# Title",
			},
			{ expanded: true },
			theme,
		);
		expect(success).toContain("more");
		expect(success).toContain("Authentication  cookie");

		const failure = formatWebFetchResult(
			{ status: "failed", error: { code: "BLOCKED_ADDRESS", message: "private network address" }, duration_ms: 1 },
			{ expanded: true },
			theme,
		);
		expect(failure).toContain("blocked");
		expect(failure).toContain("BLOCKED_ADDRESS");
	});

	it("call 卡片在 progress/result 出现后由 result 原位接管", () => {
		const args = { url: "https://example.com/page", mode: "readable" };
		const state = {};
		let call = renderWebFetchCall(args, theme, { lastComponent: undefined, state });
		expect(call.render(160)).toHaveLength(2);

		call = renderWebFetchCall(args, theme, { lastComponent: call, state });
		let result = renderWebFetchResult(
			{ details: { status: "progress", phase: "requesting" } },
			{ isPartial: true },
			theme,
			{ args, lastComponent: undefined, state },
		);
		const progress = [...call.render(160), ...result.render(160)].join("\n");
		expect(progress.split("\n")).toHaveLength(2);
		expect(progress.match(/webfetch/g)).toHaveLength(1);
		expect(progress).toContain("readable · offset 0 · requesting...");

		call = renderWebFetchCall(args, theme, { lastComponent: call, state });
		result = renderWebFetchResult(
			{ details: { status: "failed", requested_url: args.url, error: { code: "TIMEOUT", message: "deadline exceeded" } } },
			{ isPartial: false },
			theme,
			{ args, lastComponent: result, state },
		);
		const settled = [...call.render(160), ...result.render(160)].join("\n");
		expect(settled.split("\n")).toHaveLength(2);
		expect(settled.match(/webfetch/g)).toHaveLength(1);
		expect(settled).toContain("timeout");
	});
});
