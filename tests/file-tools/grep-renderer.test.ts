import { describe, expect, it } from "vitest";

import { formatGrepCall, formatGrepResult } from "../../src/file-tools/grep/renderer.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";

const theme = {
	fg(_name: string, text: string) { return text; },
	bold(text: string) { return text; },
};

describe("grep renderer", () => {
	it("折叠状态保留查询、命中统计和全部限制原因", () => {
		const call = formatGrepCall({ query: "authentication flow", path: "src", match: "auto" }, theme);
		for (const value of ["authentication flow", "src", "auto"]) expect(call).toContain(value);

		const details: GrepSuccess = {
			...success(),
			truncated_by: ["traversal_limit", "text_byte_limit", "semantic_candidate_limit", "result_limit", "token_budget"],
		};
		const summary = formatGrepResult(details, false, theme).split("\n")[1];
		expect(summary?.length).toBeLessThanOrEqual(98);
		for (const value of ["1 regions", "1 files", "1 related", "depth", "bytes", "sem", "result", "token"]) {
			expect(summary).toContain(value);
		}
	});

	it("展开状态保留 scope 错误、区域和关联文件，但不重复源码正文", () => {
		const output = formatGrepResult({
			...success(),
			paths: ["src", "tests"],
			scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "Directory does not exist." } }],
		}, true, theme);

		for (const value of [
			"src/auth.ts:4-9",
			"kind=method",
			"symbol=AuthService.login",
			"roles=definition,public-api",
			"matched-by=literal",
			"matches=2",
			"tests/auth.test.ts",
			"missing",
			"PATH_NOT_FOUND",
		]) expect(output).toContain(value);
		for (const sourceLine of ["async login", "return secretSession"]) expect(output).not.toContain(sourceLine);
	});

	it("零命中时保留 nearby 候选", () => {
		const output = formatGrepResult({
			status: "success",
			query: "authentcateUser",
			path: ".",
			match: "auto",
			total_candidates: 0,
			returned_regions: 0,
			returned_files: 0,
			approx_tokens: 30,
			stats: { traversed_entries: 1, searched_files: 1, searched_bytes: 20, parsed_files: 1 },
			truncated_by: [],
			regions: [],
			nearby: [{
				path: "src/auth.ts",
				start_line: 1,
				end_line: 3,
				kind: "function",
				symbol: "authenticateUser",
				reason: "symbol similarity",
				query_match: "not_guaranteed",
			}],
		}, true, theme);
		expect(output).toContain("src/auth.ts");
		expect(output).toContain("authenticateUser");
	});
});

function success(): GrepSuccess {
	return {
		status: "success",
		query: "authentication flow",
		path: ".",
		match: "auto",
		total_candidates: 3,
		returned_regions: 1,
		returned_files: 1,
		approx_tokens: 120,
		stats: { traversed_entries: 4, searched_files: 4, searched_bytes: 200, parsed_files: 2 },
		truncated_by: ["token_budget"],
		regions: [{
			path: "src/auth.ts",
			start_line: 4,
			end_line: 9,
			kind: "method",
			symbol: "AuthService.login",
			declaration: "async login()",
			query_match: "verified",
			roles: ["definition", "public_api"],
			matched_by: ["literal"],
			sources: ["text-literal"],
			match_lines: [5, 8],
			display_lines: [
				{ line: 5, text: "const secretSession = authenticate();", type: "match" },
				{ line: 8, text: "return secretSession;", type: "match" },
			],
		}],
		related: [{
			path: "tests/auth.test.ts",
			start_line: 2,
			end_line: 6,
			kind: "test",
			symbol: "auth flow",
			sources: ["repo-map"],
			relations: ["test"],
			query_match: "not_guaranteed",
		}],
	};
}
