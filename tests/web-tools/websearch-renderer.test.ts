import { describe, expect, it } from "vitest";

import { formatWebSearchCall, formatWebSearchResult, renderWebSearchCall, renderWebSearchResult } from "../../src/web-tools/tui/websearch.js";
import { expectRendererLifecycle, theme } from "./renderer-fixture.js";


describe("websearch renderer", () => {
	it("清理调用参数，并安全渲染各进度阶段", () => {
		expect(formatWebSearchCall({}, theme).length).toBeGreaterThan(0);
		const text = formatWebSearchCall({ query: "pi\u001b[31m search" }, theme);
		expect(text).toContain("pi search");
		expect(text).not.toContain("\u001b");

		for (const details of [
			{ ...successDetails(0), results: [] },
			{ status: "progress", phase: "waiting", wait_ms: 2000 },
			{ status: "progress", phase: "requesting" },
			{ status: "progress", phase: "downloading", received_bytes: 2048 },
			{ status: "progress", phase: "parsing" },
		] as const) {
			expect(formatWebSearchResult(details, { isPartial: true }, theme).length).toBeGreaterThan(0);
		}
	});

	it("折叠隐藏结果正文，展开后保留结果信息", () => {
		const details = successDetails(2);
		const collapsed = formatWebSearchResult(details, {}, theme);
		const expanded = formatWebSearchResult(details, { expanded: true }, theme);

		for (const value of ["Snippet 1", "https://example.com/1"]) expect(collapsed).not.toContain(value);
		for (const value of ["Title 1", "Snippet 1", "https://example.com/1", "exa_api"]) {
			expect(expanded).toContain(value);
		}
		expect(expanded.length).toBeGreaterThan(collapsed.length);
	});

	it("fallback 与失败详情保留诊断信息，且清理敏感或不可信文本", () => {
		const fallback = formatWebSearchResult(
			{
				...successDetails(1),
				provider: "duckduckgo_html" as const,
				attempts: [
					{ provider: "exa_api" as const, status: "failed" as const, error: { code: "TIMEOUT" as const, message: "secret-key" }, duration_ms: 12000 },
					{ provider: "duckduckgo_html" as const, status: "success" as const, duration_ms: 1500 },
				],
			},
			{ expanded: true },
			theme,
		);
		for (const value of ["exa_api", "duckduckgo_html"]) expect(fallback).toContain(value);
		expect(fallback).not.toContain("secret-key");

		const details = {
			status: "failed" as const,
			error: { code: "PARSE_FAILED" as const, message: "bad\u001b[31m page" },
			provider: "duckduckgo_html" as const,
			http_status: 200,
			duration_ms: 12,
			attempts: [{ provider: "duckduckgo_html" as const, status: "failed" as const, error: { code: "PARSE_FAILED" as const, message: "bad page" } }],
			response_preview: "preview\u001b]0;title\u0007 text",
		};
		const collapsed = formatWebSearchResult(details, {}, theme);
		expect(collapsed).not.toContain("\u001b");
		expect(collapsed).not.toContain("preview text");
		const expanded = formatWebSearchResult(details, { expanded: true }, theme);
		expect(expanded).toContain("PARSE_FAILED");
		expect(expanded).toContain("preview text");
		expect(expanded).not.toContain("\u001b");
	});

	it("progress 和最终结果接管调用阶段组件", () => {
		const args = { query: "pi coding agent", limit: 5 };
		expectRendererLifecycle({
			createState: () => ({}),
			renderCall: (lastComponent, state) => renderWebSearchCall(args, theme, { lastComponent, state }),
			renderProgress: (lastComponent, state) => renderWebSearchResult(
				{ details: { status: "progress", phase: "requesting" } },
				{ isPartial: true },
				theme,
				{ args, lastComponent, state },
			),
			renderSettled: (lastComponent, state) => renderWebSearchResult(
				{ details: { ...successDetails(2), query: args.query } },
				{ isPartial: false },
				theme,
				{ args, lastComponent, state },
			),
			initialContains: [args.query],
			progressContains: [args.query],
			settledContains: [args.query, "exa_api"],
		});
	});
});

function successDetails(count: number) {
	return {
		status: "success" as const,
		query: "pi search",
		provider: "exa_api" as const,
		results: Array.from({ length: count }, (_, index) => ({
			rank: index + 1,
			title: `Title ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			snippet: `Snippet ${index + 1}`,
		})),
		downloaded_bytes: 2048,
		duration_ms: 42,
		attempts: [{ provider: "exa_api" as const, status: "success" as const, duration_ms: 42 }],
	};
}
