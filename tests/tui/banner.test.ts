import os from "node:os";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatStartupBanner } from "../../src/tui/banner.js";
import { defaultTuiConfig } from "../../src/tui/config.js";
import type { TuiFooterSnapshot } from "../../src/tui/types.js";

const snapshot: TuiFooterSnapshot = {
	cwd: path.join(os.homedir(), "pi-dev"),
	git: "main*",
	modelId: "deepseek-v4-flash-free",
	modelProvider: "opencode",
	modelReasoning: true,
	thinkingLevel: "high",
	availableProviderCount: 2,
	context: { tokens: 0, contextWindow: 200_000, percent: 0 },
	status: "ready",
	tools: {
		activeNames: ["ls", "read", "write", "edit", "find", "grep", "bash", "websearch", "webfetch", "subagent", "skill"],
		totalCount: 11,
	},
	skills: { totalCount: 3, modelInvocableCount: 1 },
};

describe("regular startup banner", () => {
	it.each([120, 80, 36])("宽度 %i 下恢复旧版响应式布局且不越界", (width) => {
		const lines = formatStartupBanner(snapshot, defaultTuiConfig().home, width, plainTheme());
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("宽终端恢复旧版 wordmark、状态行和操作提示", () => {
		const output = stripTerminalSequences(
			formatStartupBanner(snapshot, defaultTuiConfig().home, 120, plainTheme()).join("\n"),
		);

		expect(output).toContain("██████╗");
		expect(output).toContain("workspace");
		expect(output).toContain("model");
		expect(output).toContain("context");
		expect(output).toContain("tools");
		expect(output).toContain("/ commands · /stats · /tools · /agents");
	});

	it("缺少可选状态时不输出占位脏值", () => {
		const output = formatStartupBanner(
			{ cwd: "/repo", status: "ready" },
			defaultTuiConfig().home,
			120,
			plainTheme(),
		).join("\n");
		expect(output).not.toMatch(/undefined|null/);
	});
});

function plainTheme() {
	return { fg: (_color: string, text: string) => text };
}
