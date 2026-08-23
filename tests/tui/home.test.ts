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

	it("wordmark 作为整体居中，不逐行漂移", () => {
		const lines = formatHomePage(snapshot, defaultTuiConfig().home, 120, editorLines, plainTheme(), homeOptions(28));
		const logoStarts = lines
			.map((line) => stripTerminalSequences(line))
			.filter((line) => /[╔╗║╝]/u.test(line))
			.map((line) => line.search(/[^ ]/));
		expect(Math.max(...logoStarts) - Math.min(...logoStarts)).toBeLessThanOrEqual(1);
	});

	it("宽屏和中屏使用不同尺寸的 Pi Core，窄屏只保留文字标识", () => {
		const full = stripTerminalSequences(formatHomePage(
			snapshot,
			defaultTuiConfig().home,
			120,
			editorLines,
			plainTheme(),
			homeOptions(28),
		).join("\n"));
		const medium = stripTerminalSequences(formatHomePage(
			snapshot,
			defaultTuiConfig().home,
			80,
			editorLines,
			plainTheme(),
			homeOptions(20),
		).join("\n"));
		const compact = stripTerminalSequences(formatHomePage(
			snapshot,
			defaultTuiConfig().home,
			40,
			editorLines,
			plainTheme(),
			homeOptions(14),
		).join("\n"));

		expect(full).toContain("─────┤   π   ├─────");
		expect(medium).toContain("───┤ π ├───");
		expect(compact).toContain("O Pi · v");
		expect(compact).not.toContain("┤ π ├");
	});

	it("Pi Core 的外框、双支柱和底部轨道逐列对齐", () => {
		const lines = formatHomePage(
			snapshot,
			defaultTuiConfig().home,
			120,
			editorLines,
			plainTheme(),
			homeOptions(28, { reveal: 1, wave: 1, orbit: 0 }),
		).map(stripTerminalSequences);
		const top = lines.find((line) => line.includes("╭───────╮"));
		const middle = lines.find((line) => line.includes("┤   π   ├"));
		const bottom = lines.find((line) => line.includes("╰──┬─┬──╯"));
		const pillars = lines.find((line) => line.includes("│ │"));
		const branches = lines.find((line) => line.includes("───╯ ╰───"));

		expect(top).toBeDefined();
		expect(middle).toBeDefined();
		expect(bottom).toBeDefined();
		expect(pillars).toBeDefined();
		expect(branches).toBeDefined();
		if (top === undefined || middle === undefined || bottom === undefined || pillars === undefined || branches === undefined) return;
		expect([top.indexOf("╭"), middle.indexOf("┤"), bottom.indexOf("╰")]).toEqual([
			top.indexOf("╭"),
			top.indexOf("╭"),
			top.indexOf("╭"),
		]);
		expect([top.indexOf("╮"), middle.indexOf("├"), bottom.indexOf("╯")]).toEqual([
			top.indexOf("╮"),
			top.indexOf("╮"),
			top.indexOf("╮"),
		]);
		const firstPost = bottom.indexOf("┬");
		const secondPost = bottom.lastIndexOf("┬");
		expect([pillars.indexOf("│"), pillars.lastIndexOf("│"), branches.indexOf("╯"), branches.indexOf("╰")]).toEqual([
			firstPost,
			secondPost,
			firstPost,
			secondPost,
		]);
	});

	it("宽屏展示项目、context 和完整能力面板", () => {
		const output = stripTerminalSequences(formatHomePage(
			snapshot,
			defaultTuiConfig().home,
			120,
			editorLines,
			plainTheme(),
			homeOptions(28, { reveal: 1, wave: 1 }, "Use @ to attach files."),
		).join("\n"));

		expect(output).toContain("PROJECT");
		expect(output).toContain("CONTEXT");
		expect(output).toContain("CAPABILITIES");
		expect(output).toContain("74k / 200k");
		expect(output).toContain("11/11 tools · 3 skills · 1 model-invocable");
		expect(output).toContain("files:6 web:2 bash skill subagent");
		expect(output).toContain("● Tip  Use @ to attach files.");
	});

	it("缺失可选数据时不展示空分区或占位值", () => {
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

		expect(wideOutput).toContain("PROJECT");
		expect(wideOutput).not.toMatch(/undefined|null|CONTEXT|CAPABILITIES/);
		expect(output).toContain("/repo");
		expect(output).not.toMatch(/undefined|null|CONTEXT|CAPABILITIES/);
	});

	it("入场逐行显现仍保持稳定高度和宽度", () => {
		const lines = formatHomePage(snapshot, defaultTuiConfig().home, 120, editorLines, plainTheme(), homeOptions(28, { reveal: 0.35, wave: 0.2 }));
		expect(lines).toHaveLength(28);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("鼠标粒子反馈只改写 Logo 且不破坏页面边界", () => {
		const lines = formatHomePage(snapshot, defaultTuiConfig().home, 120, editorLines, plainTheme(), homeOptions(28, {
			reveal: 1,
			wave: 1,
			pointer: { kind: "burst", progress: 0.35, x: 60, y: 4 },
		}));
		const output = stripTerminalSequences(lines.join("\n"));
		expect(output).toMatch(/[π*·▓]/u);
		expect(output).toContain("Ask anything");
		expect(lines).toHaveLength(28);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("Home footer 将命令入口与版本分居两端", () => {
		const line = stripTerminalSequences(formatHomeFooter(defaultTuiConfig().home, 80, plainTheme())[0] ?? "");
		expect(line).toContain("/ commands");
		expect(line).toContain("O Pi v");
		expect(visibleWidth(line)).toBe(80);
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
