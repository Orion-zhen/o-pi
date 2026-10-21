import { describe, expect, it } from "vitest";

import { renderFindResults } from "../../../src/harness/file-tools/find/renderer.ts";

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
			navigation: { narrow: [], incomplete: [] },
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
		});
		expect(result.details).not.toHaveProperty("ranking");
		expect(result.content).not.toContain("score");
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
			navigation: { narrow: [], incomplete: [] },
		});

		expect(result.details).toMatchObject({
			glob: "**/*.ts",
			matches: [],
			truncated_by: [],
		});
	});
});
