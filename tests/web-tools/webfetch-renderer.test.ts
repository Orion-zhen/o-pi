import { describe, expect, it } from "vitest";

import { formatWebFetchCall, formatWebFetchResult } from "../../src/web-tools/webfetch-renderer.js";

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
});
