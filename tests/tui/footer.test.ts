import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatFooter, GitSegmentCache, readGitSegment, type GitSegmentReader } from "../../src/tui/footer.js";
import type { TuiFooterConfig, TuiFooterSnapshot } from "../../src/tui/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-no-git-");
const cwd = path.resolve("repo", "o-pi");
const config: TuiFooterConfig = {
	max_lines: 2,
	segments: ["cwd", "git", "ctx", "tokens", "cost"],
	narrow_segments: ["cwd", "git", "ctx", "tokens", "cost"],
	style: { workspace_color: "accent", git_color: "success" },
};
const snapshot: TuiFooterSnapshot = {
	cwd,
	git: "main*",
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
	tools: { activeNames: ["read", "grep", "bash"], totalCount: 5 },
};

describe("tui footer", () => {
	it.each([200, 80, 60, 12])("宽度 %i 下最多两行且不越界", (width) => {
		const lines = formatFooter(snapshot, config, width, theme);
		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("模型和运行状态不进入 footer，工具数量固定在第二行右侧", () => {
		const lines = formatFooter(snapshot, config, 120, theme, "unicode");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("ctx");
		expect(lines.join("\n")).not.toContain("model-x");
		expect(lines.join("\n")).not.toContain("ready");
		expect(lines[1]).toMatch(/tools 3\/5$/);
	});

	it("ctx 标签和 tools 计数器都使用 dim，context 数值保留渐变色", () => {
		const styledTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
		const lines = formatFooter(snapshot, config, 120, styledTheme);
		const primary = lines[0] ?? "";
		const secondary = lines[1] ?? "";

		expect(primary).toContain("<dim>ctx </dim>");
		expect(primary).toMatch(/<dim>ctx <\/dim>\x1b\[38;2;[0-9]+;[0-9]+;[0-9]+m32\.0%\/128k\x1b\[39m/);
		expect(secondary).toContain("<dim>tools 3\/5</dim>");
	});

	it.each([
		["ascii", "git main*"],
		["unicode", "⑂ main*"],
		["nerd", " main*"],
	] as const)("%s 图标模式使用统一 Git 图标", (mode, expected) => {
		expect(formatFooter(snapshot, config, 120, theme, mode)[0]).toContain(expected);
	});

	it("缺少数据与 git 仓库时安全退化", async () => {
		const lines = formatFooter({ cwd, status: "ready" }, config, 120, theme);
		expect(lines.join("\n")).not.toMatch(/undefined|null/);
		await expect(readGitSegment(temp.path)).resolves.toBeUndefined();
	});

	it("dispose 会取消 Git 查询并阻止完成回调", () => {
		let observedSignal: AbortSignal | undefined;
		const reader: GitSegmentReader = (_cwd, signal) => {
			observedSignal = signal;
			return new Promise<string | undefined>(() => {});
		};
		const onChange = () => {
			throw new Error("disposed cache must not update the snapshot");
		};
		const cache = new GitSegmentCache(onChange, reader);

		cache.get(temp.path);
		cache.dispose();

		expect(observedSignal?.aborted).toBe(true);
	});
});

const theme = { fg: (_color: string, text: string) => text };
