import { describe, expect, it } from "vitest";
import { configureTuiIconMode } from "../../src/tui/icons.js";
import { formatToolCard } from "../../src/tui/tool-card.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("tui tool card", () => {
	it("截断 target、summary 并清理控制字符", () => {
		const output = formatToolCard({
			tool: "webfetch",
			status: "success",
			target: "https://example.com/" + "a".repeat(40) + "TARGET_SECRET" + "a".repeat(40) + "/end",
			summary: `ok\u001b[31m ${"b".repeat(80)}SUMMARY_END`,
		}, theme, { maxTargetChars: 24, maxSummaryChars: 20 });
		for (const value of ["https://exam", "/end", "ok"]) expect(output).toContain(value);
		for (const value of ["\u001b", "TARGET_SECRET", "SUMMARY_END"]) expect(output).not.toContain(value);
	});

	it("默认使用全局统一图标模式", () => {
		configureTuiIconMode("ascii");
		try {
			expect(formatToolCard({ tool: "read", status: "success", target: "a.ts", summary: "ok" }, theme)).toMatch(/^\+ /);
		} finally {
			configureTuiIconMode("unicode");
		}
	});
});
