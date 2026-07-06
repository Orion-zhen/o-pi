import { describe, expect, it } from "vitest";

import { formatWebSearchCall, formatWebSearchResult } from "../../src/web-tools/websearch-renderer.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("websearch renderer", () => {
	it("残缺 args 不崩溃并清理 query 控制字符", () => {
		expect(formatWebSearchCall({}, theme)).toContain("...");
		const text = formatWebSearchCall({ query: "pi\u001b[31m search" }, theme);
		expect(text).toContain('"pi search"');
		expect(text).not.toContain("\u001b");
	});

	it("折叠只显示 2 行卡片，不直接显示搜索结果列表", () => {
		const rendered = formatWebSearchResult(successDetails(5), {}, theme);
		expect(rendered.split("\n")).toHaveLength(2);
		expect(rendered).toContain("5 results");
		expect(rendered).not.toContain("1. Title 1");
		expect(rendered).not.toContain("4. Title 4");
		expect(rendered).toContain("cache miss");
		expect(rendered).toContain("exa_mcp");
	});

	it("展开显示完整结果、摘要、URL 和 metadata", () => {
		const rendered = formatWebSearchResult(successDetails(2), { expanded: true }, theme);
		expect(rendered).toContain("Snippet 1");
		expect(rendered).toContain("https://example.com/1");
		expect(rendered).toContain("Provider        exa_mcp");
		expect(rendered).toContain("Cache           miss");
		expect(rendered).toContain("Downloaded      2.0 KB");
	});

	it("fallback success 展开显示 attempts 且不泄漏 key", () => {
		const rendered = formatWebSearchResult(
			{
				...successDetails(1),
				provider: "duckduckgo_html" as const,
				attempts: [
					{ provider: "exa_mcp" as const, status: "failed" as const, error: { code: "TIMEOUT" as const, message: "secret-key" }, duration_ms: 12000 },
					{ provider: "duckduckgo_html" as const, status: "success" as const, duration_ms: 1500 },
				],
			},
			{ expanded: true },
			theme,
		);
		expect(rendered).toContain("fallback");
		expect(rendered).toContain("Attempts");
		expect(rendered).toContain("exa_mcp");
		expect(rendered).toContain("duckduckgo_html");
		expect(rendered).not.toContain("secret-key");
	});

	it("零结果和 progress 三种阶段", () => {
		expect(formatWebSearchResult({ ...successDetails(0), results: [] }, {}, theme)).toContain("no results");
		expect(formatWebSearchResult({ status: "progress", phase: "waiting", wait_ms: 2000 }, { isPartial: true }, theme)).toContain("waiting 2s");
		expect(formatWebSearchResult({ status: "progress", phase: "requesting" }, { isPartial: true }, theme)).toContain("searching");
		expect(formatWebSearchResult({ status: "progress", phase: "downloading", received_bytes: 2048 }, { isPartial: true }, theme)).toContain("2.0 KB");
		expect(formatWebSearchResult({ status: "progress", phase: "parsing" }, { isPartial: true }, theme)).toContain("parsing");
	});

	it("failure 折叠和展开，且网页 ANSI/OSC 不进入输出", () => {
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
		expect(collapsed).toContain("PARSE_FAILED");
		expect(collapsed).not.toContain("\u001b");
		const expanded = formatWebSearchResult(details, { expanded: true }, theme);
		expect(expanded).toContain("Status          200");
		expect(expanded).toContain("Attempts");
		expect(expanded).toContain("preview text");
		expect(expanded).not.toContain("\u001b");
	});
});

function successDetails(count: number) {
	return {
		status: "success" as const,
		query: "pi search",
		provider: "exa_mcp" as const,
		results: Array.from({ length: count }, (_, index) => ({
			rank: index + 1,
			title: `Title ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			snippet: `Snippet ${index + 1}`,
		})),
		cached: false,
		downloaded_bytes: 2048,
		duration_ms: 42,
		attempts: [{ provider: "exa_mcp" as const, status: "success" as const, duration_ms: 42 }],
	};
}
