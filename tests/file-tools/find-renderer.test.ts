import { describe, expect, it } from "vitest";

import { renderFindResults } from "../../src/file-tools/find/renderer.js";
import { countTextTokensSync } from "../../src/token-counter.js";

const stats = {
	traversed_entries: 2,
	ignored_entries: 0,
	skipped_entries: 0,
};

describe("find renderer", () => {
	it("按 relevance 顺序直接输出具体路径，不折叠或增加排名元数据", () => {
		const result = renderFindResults({
			query: "handler",
			path: ".",
			paths: ["."],
			totalCandidates: 2,
			totalMatches: 2,
			matches: [
				{ path: "src/features/authentication/first-handler.ts", kind: "file" },
				{ path: "src/features/authentication/second-handler.ts", kind: "file" },
			],
			stats,
			depthLimited: false,
			entryLimited: false,
			resultLimited: false,
			outputTokenBudget: 1_000,
		});

		expect(result.content).toBe([
			"src/features/authentication/first-handler.ts",
			"src/features/authentication/second-handler.ts",
		].join("\n"));
		expect(result.details).toMatchObject({
			status: "success",
			total_candidates: 2,
			total_matches: 2,
			returned_matches: 2,
			truncated_by: [],
			ranking: { algorithm: "fzf-v2-path-v1" },
		});
		expect(result.content).not.toContain("score");
	});

	it("预算不足时保留完整路径行并把截断状态放在首行", () => {
		const matches = Array.from({ length: 20 }, (_value, index) => ({
			path: `src/features/very-long-directory/handler-${String(index).padStart(2, "0")}.ts`,
			kind: "file" as const,
		}));
		const result = renderFindResults({
			query: "handler",
			path: ".",
			paths: ["."],
			totalCandidates: 40,
			totalMatches: 40,
			matches,
			stats: { ...stats, traversed_entries: 40 },
			depthLimited: true,
			entryLimited: false,
			resultLimited: true,
			outputTokenBudget: 48,
		});

		expect(result.content.split("\n")[0]).toBe(
			"matched=40 selected=20; truncated=depth_limit,result_limit,output_limit",
		);
		expect(result.details.truncated_by).toEqual(["depth_limit", "result_limit", "output_limit"]);
		expect(result.details.displayed_matches.length).toBeLessThan(matches.length);
		expect(countTextTokensSync(result.content).tokens).toBeLessThanOrEqual(48);
		for (const line of result.content.split("\n").slice(1)) {
			expect(matches.some((match) => match.path === line)).toBe(true);
		}
	});

	it("零结果保留扫描摘要、glob 和部分 scope 错误", () => {
		const result = renderFindResults({
			query: "missing",
			path: "src",
			paths: ["src"],
			glob: "**/*.ts",
			scopeErrors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "missing" } }],
			totalCandidates: 8,
			totalMatches: 0,
			matches: [],
			stats: {
				traversed_entries: 8,
				ignored_entries: 2,
				skipped_entries: 1,
			},
			depthLimited: false,
			entryLimited: false,
			resultLimited: false,
			outputTokenBudget: 1_000,
		});

		expect(result.content).toBe([
			"partial; scope_errors=missing:PATH_NOT_FOUND",
			"none",
			"searched=8; ignored=2; skipped=1",
			"next: refine query/path/glob",
		].join("\n"));
		expect(result.details).toMatchObject({
			glob: "**/*.ts",
			displayed_matches: [],
			truncated_by: [],
		});
	});
});
