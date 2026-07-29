import { describe, expect, it } from "vitest";

import { formatGrepCall, formatGrepResult } from "../../src/file-tools/grep/renderer.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";

const theme = {
	fg(_name: string, text: string) { return text; },
	bold(text: string) { return text; },
};

describe("grep renderer", () => {
	it("折叠状态保留查询、命中统计和全部限制原因", () => {
		const call = formatGrepCall({ query: "authentication flow", path: "src" }, theme);
		for (const value of ["authentication flow", "src"]) expect(call).toContain(value);

		const details: GrepSuccess = {
			...success(),
			truncated_by: ["traversal_limit", "result_limit"],
		};
		const summary = formatGrepResult(details, false, theme).split("\n")[1];
		expect(summary?.length).toBeLessThanOrEqual(98);
		for (const value of ["1 regions", "1 files", "depth", "result"]) {
			expect(summary).toContain(value);
		}
	});

	it("展开状态保留 scope 错误和代码区域，但不重复代码正文", () => {
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
			"matched-by=regex",
			"matches=2",
			"missing",
			"PATH_NOT_FOUND",
		]) expect(output).toContain(value);
		for (const sourceLine of ["async login", "return secretSession"]) expect(output).not.toContain(sourceLine);
	});

	it("展开状态按同文件压缩连续 text region", () => {
		const output = formatGrepResult({
			...success(),
			total_candidates: 3,
			returned_regions: 3,
			returned_files: 2,
			truncated_by: [],
			regions: [
				textRegion("agent/defaults/file-tools.jsonc", 29, "\"grep_max_depth\": 12,"),
				textRegion("agent/defaults/file-tools.jsonc", 30, "\"grep_ast_max_file_bytes\": 262144,"),
				textRegion("agent/defaults/lsp.jsonc", 24, "\"workspace_symbol_limit\": 24"),
			],
		}, true, theme);

		expect(output).toContain([
			"agent/defaults/file-tools.jsonc:",
			"  29: \"grep_max_depth\": 12,",
			"  30: \"grep_ast_max_file_bytes\": 262144,",
		].join("\n"));
		expect(output.match(/agent\/defaults\/file-tools\.jsonc/g)).toHaveLength(1);
		expect(output).not.toContain("kind=text");
		expect(output).toContain("agent/defaults/lsp.jsonc:24: \"workspace_symbol_limit\": 24");
	});
});

function success(): GrepSuccess {
	return {
		status: "success",
		query: "authentication flow",
		path: ".",
		total_candidates: 3,
		returned_regions: 1,
		returned_files: 1,
		approx_tokens: 120,
		stats: {
			traversed_entries: 4,
			searched_files: 4,
			searched_bytes: 200,
			text_hits: 2,
			parsed_files: 2,
			dropped_text_hits: 0,
			dropped_related_anchors: 0,
			dropped_related_results: 0,
			ast_skipped_oversized_files: 0,
		},
		truncated_by: ["result_limit"],
		regions: [{
			path: "src/auth.ts",
			start_line: 4,
			end_line: 9,
			kind: "method",
			symbol: "AuthService.login",
			declaration: "async login()",
			query_match: "verified",
			roles: ["definition", "public_api"],
			matched_by: ["regex"],
			sources: ["text-regex"],
			match_lines: [5, 8],
			display_lines: [
				{ line: 5, text: "const secretSession = authenticate();", type: "match" },
				{ line: 8, text: "return secretSession;", type: "match" },
			],
		}],
	};
}

function textRegion(path: string, line: number, text: string): GrepSuccess["regions"][number] {
	return {
		path,
		start_line: line,
		end_line: line,
		kind: "text",
		query_match: "verified",
		roles: ["text"],
		matched_by: ["regex"],
		sources: ["text-regex"],
		match_lines: [line],
		display_lines: [{ line, text, type: "match" }],
	};
}
