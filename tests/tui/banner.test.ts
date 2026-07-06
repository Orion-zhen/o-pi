import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatStartupBanner } from "../../src/tui/banner.js";
import { defaultTuiConfig } from "../../src/tui/config.js";
import type { TuiBannerConfig, TuiFooterSnapshot } from "../../src/tui/types.js";

const allNames = ["ls", "read", "write", "edit", "find", "grep", "bash", "websearch", "webfetch", "subagent"];
const baseConfig: TuiBannerConfig = defaultTuiConfig().banner;

const snapshot: TuiFooterSnapshot = {
	cwd: path.join(os.homedir(), "pi-dev"),
	git: "main*",
	modelId: "deepseek-v4-flash-free",
	modelProvider: "opencode",
	modelReasoning: true,
	thinkingLevel: "high",
	availableProviderCount: 2,
	context: { tokens: 0, contextWindow: 200000, percent: 0 },
	status: "ready",
	tools: { activeNames: allNames, totalCount: allNames.length, allNames },
	skills: { totalCount: 3, userCount: 2, projectCount: 1, temporaryCount: 0 },
};

describe("startup banner", () => {
	it("width 120 使用 side-by-side 并包含完整状态", () => {
		const lines = formatStartupBanner(snapshot, baseConfig, 120, plainTheme());
		const output = lines.join("\n");
		expect(output).toContain("██████");
		expect(output).toContain("workspace");
		expect(output).toContain("~/pi-dev");
		expect(output).toContain("(opencode) deepseek-v4-flash-free • high");
		expect(output).toContain("0.0%/200k");
		expect(output).toContain("10/10");
		expect(output).toContain("files:4 search:2 shell:1 web:2 agent:1");
		expect(output).toContain("skills     3 · user:2 · project:1");
		expect(output).toContain("/ commands");
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("width 80 使用 stacked", () => {
		const lines = formatStartupBanner(snapshot, baseConfig, 80, plainTheme());
		expect(lines[0]).toContain("██████");
		expect(lines.some((line) => line.startsWith("workspace"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("width 36 使用 tiny", () => {
		const lines = formatStartupBanner(snapshot, baseConfig, 36, plainTheme());
		expect(lines.join("\n")).toContain("O Pi");
		expect(lines.join("\n")).not.toContain("____");
		expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
	});

	it("缺 model/context/git 时不输出假数据", () => {
		const lines = formatStartupBanner({ cwd: "/repo", status: "ready" }, baseConfig, 120, plainTheme());
		const output = lines.join("\n");
		expect(output).not.toContain("undefined");
		expect(output).not.toContain("null");
		expect(output).not.toContain("model");
		expect(output).not.toContain("context");
		expect(output).not.toContain("git");
	});

	it("show_hints false 时不显示 hints", () => {
		const lines = formatStartupBanner(snapshot, { ...baseConfig, show_hints: false }, 120, plainTheme());
		expect(lines.join("\n")).not.toContain("/ commands");
	});

	it("show_capabilities false 时 tools 行只显示数量", () => {
		const lines = formatStartupBanner(snapshot, { ...baseConfig, show_capabilities: false }, 120, plainTheme());
		const toolsLine = lines.find((line) => line.includes("tools")) ?? "";
		expect(toolsLine).toContain("10/10");
		expect(toolsLine).not.toContain("files:4");
		expect(lines.join("\n")).toContain("skills     3 · user:2 · project:1");
	});

	it("无 skills 时不显示 skills 行", () => {
		const { skills: _skills, ...snapshotWithoutSkills } = snapshot;
		const lines = formatStartupBanner(snapshotWithoutSkills, baseConfig, 120, plainTheme());
		expect(lines.join("\n")).not.toContain("skills");
	});

	it("temporary skills 单独显示 temp 计数", () => {
		const lines = formatStartupBanner({ ...snapshot, skills: { totalCount: 3, userCount: 1, projectCount: 1, temporaryCount: 1 } }, baseConfig, 120, plainTheme());
		expect(lines.join("\n")).toContain("skills     3 · user:1 · project:1 · temp:1");
	});

	it("clean/dirty git 使用不同颜色", () => {
		const dirtyCalls = recordTheme();
		formatStartupBanner(snapshot, baseConfig, 120, dirtyCalls.theme);
		expect(dirtyCalls.calls).toContainEqual({ color: "warning", text: "main*" });

		const cleanCalls = recordTheme();
		formatStartupBanner({ ...snapshot, git: "main" }, baseConfig, 120, cleanCalls.theme);
		expect(cleanCalls.calls).toContainEqual({ color: "success", text: "main" });
	});
});

function plainTheme() {
	return { fg: (_color: string, text: string) => text };
}

function recordTheme() {
	const calls: Array<{ color: string; text: string }> = [];
	return {
		calls,
		theme: {
			fg(color: string, text: string): string {
				calls.push({ color, text });
				return text;
			},
		},
	};
}
