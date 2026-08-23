import os from "node:os";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatHomeFooter, formatHomePage, selectHomeTip, type HomeAnimationFrame, type HomePageOptions } from "../../src/tui/home.js";
import { defaultTuiConfig } from "../../src/tui/config.js";
import type { TuiFooterSnapshot } from "../../src/tui/types.js";

const snapshot: TuiFooterSnapshot = {
	cwd: path.join(os.homedir(), "pi-dev"),
	git: "main",
	modelId: "deepseek-v4-flash-free",
	modelProvider: "opencode",
	modelReasoning: true,
	thinkingLevel: "high",
	availableProviderCount: 2,
	context: { tokens: 74_000, contextWindow: 200_000, percent: 37 },
	status: "ready",
	tools: {
		activeNames: ["ls", "read", "write", "edit", "find", "grep", "bash", "websearch", "webfetch", "subagent", "skill"],
		totalCount: 11,
		allNames: ["ls", "read", "write", "edit", "find", "grep", "bash", "websearch", "webfetch", "subagent", "skill"],
	},
	skills: { totalCount: 3, modelInvocableCount: 1 },
};

const editorLines = ["─ NEW SESSION ─", "Ask anything...", "─ ● ready ─"];

describe("startup home", () => {
	it.each([
		{ width: 120, height: 28 },
		{ width: 80, height: 20 },
		{ width: 40, height: 14 },
		{ width: 24, height: 8 },
	])("$width×$height 下按宽高降级且不越界", ({ width, height }) => {
		const lines = formatHomePage(snapshot, defaultTuiConfig().home, width, editorLines, plainTheme(), homeOptions(height));

		expect(lines).toHaveLength(height);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(stripTerminalSequences(lines.join("\n"))).toContain("Ask anything");
	});

	it("宽屏保留项目、上下文和能力信息", () => {
		const output = stripTerminalSequences(formatHomePage(
			snapshot,
			defaultTuiConfig().home,
			120,
			editorLines,
			plainTheme(),
			homeOptions(28),
		).join("\n"));

		for (const value of ["pi-dev", "74k", "200k", "11/11", "3 skills"]) expect(output).toContain(value);
	});

	it("缺失可选数据时不展示占位脏值", () => {
		const wideOutput = stripTerminalSequences(formatHomePage(
			{ cwd: "/repo", status: "ready" },
			defaultTuiConfig().home,
			120,
			editorLines,
			plainTheme(),
			homeOptions(28),
		).join("\n"));
		const output = stripTerminalSequences(formatHomePage(
			{ cwd: "/repo", status: "ready" },
			defaultTuiConfig().home,
			40,
			editorLines,
			plainTheme(),
			homeOptions(12),
		).join("\n"));

		expect(wideOutput).not.toMatch(/undefined|null/);
		expect(output).toContain("/repo");
		expect(output).not.toMatch(/undefined|null/);
	});

	it("入场动画保持稳定高度和宽度", () => {
		const lines = formatHomePage(snapshot, defaultTuiConfig().home, 120, editorLines, plainTheme(), homeOptions(28, { reveal: 0.35, wave: 0.2 }));
		expect(lines).toHaveLength(28);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("鼠标反馈不破坏页面边界或输入信息", () => {
		const lines = formatHomePage(snapshot, defaultTuiConfig().home, 120, editorLines, plainTheme(), homeOptions(28, {
			reveal: 1,
			wave: 1,
			pointer: { kind: "burst", progress: 0.35, x: 60, y: 4 },
		}));
		const output = stripTerminalSequences(lines.join("\n"));
		expect(output).toContain("Ask anything");
		expect(lines).toHaveLength(28);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it.each([40, 20, 8, 1])("Home footer 在宽度 %i 下不会越界", (width) => {
		const line = formatHomeFooter(defaultTuiConfig().home, width, plainTheme())[0] ?? "";
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("同一 session 的提示稳定", () => {
		expect(selectHomeTip("session-a")).toBe(selectHomeTip("session-a"));
	});
});

function homeOptions(
	height: number,
	animation: HomeAnimationFrame = { reveal: 1, wave: 1 },
	tip = selectHomeTip("session-test"),
): HomePageOptions {
	return { height, tip, animation };
}

function plainTheme() {
	return { fg: (_color: string, text: string) => text };
}
