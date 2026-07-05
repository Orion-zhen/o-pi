import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatFooter, readGitSegment } from "../src/tui/footer.js";
import type { TuiFooterConfig } from "../src/tui/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
};

const config: TuiFooterConfig = {
	max_lines: 2,
	segments: ["cwd", "git", "model", "ctx", "tokens", "cost", "status"],
	narrow_segments: ["cwd", "git", "model", "ctx", "tokens", "cost", "status"],
	style: {
		workspace_color: "accent",
		git_color: "success",
		git_icon: "⑂",
	},
};

describe("tui footer", () => {
	it("缺数据时隐藏 segment", () => {
		const [output] = formatFooter({ cwd: "/repo/o-pi", status: "ready" }, config, 120);
		expect(output).toContain("/repo/o-pi");
		expect(output?.trimEnd().endsWith("ready")).toBe(true);
		expect(output).not.toContain("model");
		expect(output).not.toContain("tok");
	});

	it("git 不可用时不崩溃", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "o-pi-no-git-"));
		await expect(readGitSegment(dir)).resolves.toBeUndefined();
	});

	it("窄屏使用 narrow_segments 降级", () => {
		const output = formatFooter(
			{ cwd: "/repo/o-pi", git: "main*", modelId: "model-x", context: { tokens: 41, contextWindow: 100, percent: 41 }, inputTokens: 12000, outputTokens: 4000, costUsd: 0.03, status: "ready" },
			config,
			60,
		);
		expect(output[0]).toContain("⑂ main*");
		expect(output[0]).toContain("41.0%/100");
		expect(output[0]).toContain("model-x");
		expect(output[0]).not.toContain("↑12k");
		expect(output[1]).toContain("↑12k");
		expect(output[1]).toContain("$0.030");
	});

	it("展示 workspace、git 图标、token/cache、cost 和模型详情", () => {
		const output = formatFooter(
			{
				cwd: path.join(os.homedir(), "coding", "ml-detect"),
				git: "main*",
				modelId: "gpt-5.2",
				modelProvider: "openai",
				modelReasoning: true,
				thinkingLevel: "high",
				availableProviderCount: 2,
				context: { tokens: 41000, contextWindow: 128000, percent: 32.03125 },
				inputTokens: 12345,
				outputTokens: 4100,
				cacheReadTokens: 2000,
				cacheWriteTokens: 300,
				latestCacheHitRate: 13.7,
				totalCacheHitRate: 13.7,
				costUsd: 0.031,
				usingSubscription: true,
				status: "ready",
			},
			config,
			200,
		);
		expect(output[0]).toContain("~/coding/ml-detect");
		expect(output[0]).toContain("⑂ main*");
		expect(output[0]).toContain("32.0%/128k");
		expect(output[0]).toContain("(openai) gpt-5.2 • high");
		expect(output[0]).toContain("ready");
		expect(output[0]).not.toContain("↑12k");
		expect(output[0]).not.toContain("$0.031");
		expect(output[1]).toContain("↑12k ↓4.1k cache R2.0k W300 hit 13.7% total 13.7%");
		expect(output[1]).toContain("$0.031 (sub)");
	});

	it("cache 明细区分最近命中率和累计命中率", () => {
		const output = formatFooter(
			{
				inputTokens: 10000,
				outputTokens: 2000,
				cacheReadTokens: 5000,
				cacheWriteTokens: 1000,
				latestCacheHitRate: 80,
				totalCacheHitRate: 31.25,
			},
			config,
			120,
		);
		expect(output[1]).toContain("cache R5.0k W1.0k hit 80.0% total 31.3%");
	});

	it("中等宽度保留 cache 读写和命中率", () => {
		const output = formatFooter(
			{
				inputTokens: 10000,
				outputTokens: 2000,
				cacheReadTokens: 5000,
				cacheWriteTokens: 1000,
				latestCacheHitRate: 80,
				totalCacheHitRate: 31.25,
				costUsd: 0.031,
				tools: { activeNames: ["read", "grep", "bash"], totalCount: 5 },
			},
			config,
			80,
			theme,
		);
		expect(output[1]).toContain("cache R5.0k/W1.0k hit 80.0% total 31.3%");
		expect(output[1]).toContain("$0.031");
		expect(output[1]?.trimEnd().endsWith("3/5 tools enabled")).toBe(true);
		expect(visibleWidth(output[1] ?? "")).toBeLessThanOrEqual(80);
	});

	it("窄宽度优先保留 cache 命中率", () => {
		const output = formatFooter(
			{
				inputTokens: 10000,
				outputTokens: 2000,
				cacheReadTokens: 5000,
				cacheWriteTokens: 1000,
				latestCacheHitRate: 80,
				totalCacheHitRate: 31.25,
				costUsd: 0.031,
				tools: { activeNames: ["read", "grep", "bash"], totalCount: 5 },
			},
			config,
			60,
			theme,
		);
		expect(output[1]).toContain("cache hit 80.0% total 31.3%");
		expect(output[1]).toContain("$0.031");
		expect(output[1]?.trimEnd().endsWith("3/5 tools enabled")).toBe(true);
		expect(visibleWidth(output[1] ?? "")).toBeLessThanOrEqual(60);
	});

	it("context 使用量按百分比生成绿色到红色渐变", () => {
		const [low] = formatFooter({ context: { tokens: 0, contextWindow: 100000, percent: 0 } }, config, 120, theme);
		const [mid] = formatFooter({ context: { tokens: 50000, contextWindow: 100000, percent: 50 } }, config, 120, theme);
		const [high] = formatFooter({ context: { tokens: 95000, contextWindow: 100000, percent: 95 } }, config, 120, theme);
		expect(low).toContain("\x1b[38;2;46;204;113m0.0%/100k\x1b[39m");
		expect(mid).toContain("\x1b[38;2;241;196;15m50.0%/100k\x1b[39m");
		expect(high).toContain("\x1b[38;2;232;88;56m95.0%/100k\x1b[39m");
	});

	it("第二行右侧只展示工具启用数量", () => {
		const output = formatFooter({ inputTokens: 12000, tools: { activeNames: ["read", "grep", "bash"], totalCount: 5 } }, config, 80, theme);
		expect(output).toHaveLength(2);
		expect(output[1]).toContain("↑12k");
		expect(output[1]).not.toContain("read");
		expect(output[1]).not.toContain("grep");
		expect(output[1]).not.toContain("bash");
		expect(output[1]?.trimEnd().endsWith("3/5 tools enabled")).toBe(true);
	});

	it("非彩色 footer 文本使用 dim token", () => {
		const calls: Array<{ color: string; text: string }> = [];
		const output = formatFooter(
			{
				cwd: "/repo/o-pi",
				git: "main",
				modelId: "model-x",
				context: { tokens: 41, contextWindow: 100, percent: 41 },
				inputTokens: 12000,
				costUsd: 0.03,
				status: "ready",
				tools: { activeNames: ["read"], totalCount: 3 },
			},
			config,
			120,
			{
				fg(color, text) {
					calls.push({ color, text });
					return text;
				},
			},
		);
		expect(output.join("\n")).toContain("1/3 tools enabled");
		expect(calls).toContainEqual({ color: "accent", text: "/repo/o-pi" });
		expect(calls).toContainEqual({ color: "success", text: "⑂ main" });
		expect(calls).toContainEqual({ color: "dim", text: "model-x" });
		expect(calls).toContainEqual({ color: "dim", text: "↑12k" });
		expect(calls).toContainEqual({ color: "dim", text: "$0.030" });
		expect(calls).toContainEqual({ color: "dim", text: "ready" });
		expect(calls).toContainEqual({ color: "dim", text: "1/3 tools enabled" });
	});

	it("极窄宽度仍截断 footer 行", () => {
		const output = formatFooter(
			{ cwd: "/repo/very-long-project-name", status: "ready", tools: { activeNames: ["read", "grep", "bash", "webfetch"], totalCount: 10 } },
			config,
			12,
			theme,
		);
		expect(output).toHaveLength(2);
		expect(output.every((line) => visibleWidth(line) <= 12)).toBe(true);
	});
});
