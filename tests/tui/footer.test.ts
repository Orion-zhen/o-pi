import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatFooter, GitSegmentCache, readGitSegment, type GitSegmentReader } from "../../src/tui/footer.js";
import type { TuiFooterConfig, TuiFooterSnapshot } from "../../src/tui/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-no-git-");
const config: TuiFooterConfig = {
	max_lines: 2,
	segments: ["cwd", "git", "model", "ctx", "tokens", "cost", "status"],
	narrow_segments: ["cwd", "git", "model", "ctx", "tokens", "cost", "status"],
	style: { workspace_color: "accent", git_color: "success", git_icon: "⑂" },
};
const snapshot: TuiFooterSnapshot = {
	cwd: "/repo/o-pi",
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

	it("缺少数据与 git 仓库时安全退化", async () => {
		const lines = formatFooter({ cwd: "/repo/o-pi", status: "ready" }, config, 120, theme);
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
