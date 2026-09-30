import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatContext, formatFooter } from "../../../src/tui/shell/footer.ts";
import type { TuiFooterConfig, TuiSnapshot } from "../../../src/tui/shell/types.ts";

import { tuiSnapshot } from "./fixtures.ts";

const cwd = path.resolve("repo", "o-pi");
const config: TuiFooterConfig = {
	segments: ["cwd", "git", "ctx", "tokens", "cost"],
	narrow_segments: ["cwd", "git", "ctx", "tokens", "cost"],
	style: { workspace_color: "accent", git_color: "success" },
};
const snapshot: TuiSnapshot = {
	...tuiSnapshot({ cwd }),
	git: "main",
	modelId: "model-x",
	context: { tokens: 41_000, contextWindow: 128_000, percent: 32 },
	inputTokens: 12_000,
	outputTokens: 4_000,
	cacheReadTokens: 2_000,
	cacheWriteTokens: 300,
	latestCacheHitRate: 13.7,
	totalCacheHitRate: 13.7,
	costUsd: 0.031,
	status: "ready",
	tools: {
		activeNames: ["read", "grep", "bash"],
		allNames: ["read", "grep", "bash", "write", "edit"],
	},
};

describe("tui footer", () => {
	it.each([[0, "success"], [69.9, "success"], [70, "warning"], [89.9, "warning"], [90, "error"], [105, "error"]] as const)("用量 %s 使用主题 %s 色", (percent, color) => {
		const output = formatContext({ ...snapshot, context: { tokens: 0, contextWindow: 128000, percent } }, {
			fg: (name, text) => `<${name}>${text}</${name}>`,
		});
		expect(output).toContain(`<${color}>${percent.toFixed(1)}%/128k</${color}>`);
		expect(output).not.toContain("\x1b");
	});

	it.each([200, 80, 60, 12])("宽度 %i 下最多两行且不越界", (width) => {
		const lines = formatFooter(snapshot, config, width, theme);
		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("隐藏模型和运行状态但保留工具数量", () => {
		const output = formatFooter(snapshot, config, 120, theme).join("\n");
		expect(output).not.toContain("model-x");
		expect(output).not.toContain("ready");
		expect(output).toContain("3/5");
	});

	it("缺少数据时安全退化", () => {
		const lines = formatFooter(tuiSnapshot({ cwd }), config, 120, theme);
		expect(lines.join("\n")).not.toMatch(/undefined|null/);
	});
});

const theme = { fg: (_color: string, text: string) => text };
