import { describe, expect, it } from "vitest";
import { formatToolCard } from "../../src/tui/tool-card.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("tui tool card", () => {
	it("渲染成功、失败、运行中三态且永远 2 行", () => {
		for (const status of ["success", "error", "running"] as const) {
			const output = formatToolCard({ tool: "grep", status, target: "src", summary: "done" }, theme);
			expect(output.split("\n")).toHaveLength(2);
		}
		expect(formatToolCard({ tool: "grep", status: "success", target: "src", summary: "done" }, theme)).toContain("✓");
		expect(formatToolCard({ tool: "grep", status: "error", target: "src", summary: "failed" }, theme)).toContain("✕");
		expect(formatToolCard({ tool: "grep", status: "running", target: "src", summary: "searching" }, theme)).toContain("●");
	});

	it("支持 ASCII icon fallback", () => {
		const output = formatToolCard(
			{ tool: "grep", status: "success", target: "src", summary: "done" },
			theme,
			{ icons: "ascii" },
		);
		expect(output).toContain("OK");
	});

	it("截断 target、summary 并清理控制字符", () => {
		const output = formatToolCard(
			{ tool: "webfetch", status: "success", target: "https://example.com/" + "a".repeat(80), summary: "ok\u001b[31m " + "b".repeat(80) },
			theme,
			{ maxTargetChars: 24, maxSummaryChars: 20 },
		);
		expect(output).not.toContain("\u001b");
		expect(output).toContain("…");
		expect(output.split("\n")).toHaveLength(2);
	});
});
