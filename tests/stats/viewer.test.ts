import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { StatsViewer } from "../../src/stats/stats-viewer.js";
import type { StatsSnapshot } from "../../src/stats/types.js";

describe("stats viewer", () => {
	it("Esc、q、Enter 关闭，滚动键不关闭", () => {
		for (const key of ["q", "\x1b", "\r"]) {
			let closed = 0;
			const viewer = new StatsViewer(snapshot(), theme(), () => 10, () => {
				closed += 1;
			});

			viewer.handleInput(Key.down);
			expect(closed).toBe(0);
			viewer.handleInput(key);
			expect(closed).toBe(1);
		}
	});

	it("渲染行数按终端高度限制", () => {
		const viewer = new StatsViewer(snapshot(), theme(), () => 8, () => {});
		expect(viewer.render(80)).toHaveLength(6);
	});

	it("渲染带边框的浮层并限制宽度", () => {
		const viewer = new StatsViewer(snapshot(), theme(), () => 10, () => {});
		const lines = viewer.render(80);

		expect(lines[0]).toBe(`╭${"─".repeat(78)}╮`);
		expect(lines.at(-1)).toBe(`╰${"─".repeat(78)}╯`);
		expect(lines[1]?.startsWith("│ ")).toBe(true);
		expect(lines[1]?.endsWith(" │")).toBe(true);
		expect(lines[1]).toContain("Stats");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});
});

function theme(): Pick<Theme, "fg"> {
	return {
		fg: (_color: string, text: string) => text,
	};
}

function snapshot(): StatsSnapshot {
	return {
		session: { cwd: "/repo", userTurns: 1, assistantTurns: 1, status: "ready" },
		usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalObservedTokens: 2 },
		cache: {},
		context: {
			totalTokens: 10,
			contextWindow: 100,
			percent: 10,
			confidence: "mixed",
			items: [{ id: "conversation_history", label: "conversation history", tokens: 10, share: 100, estimated: true, note: "1 message" }],
			notes: [],
		},
		tools: { calls: 0, byName: [] },
		generatedAt: new Date("2026-07-05T00:00:00Z"),
	};
}
