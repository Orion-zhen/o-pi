import { describe, expect, it } from "vitest";

import { formatGrepCall, formatGrepResult } from "../../src/file-tools/tui/grep-format.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";

const theme = {
	fg(_name: string, text: string) { return text; },
	bold(text: string) { return text; },
};

describe("grep renderer", () => {
	it("折叠状态保留查询，且限制状态会改变摘要", () => {
		const call = formatGrepCall({ query: "authentication flow", path: "src" }, theme);
		for (const value of ["authentication flow", "src"]) expect(call).toContain(value);

		const base = success();
		const limited: GrepSuccess = {
			...base,
			truncated_by: ["traversal_limit", "result_limit"],
		};
		expect(formatGrepResult(limited, false, theme)).not.toBe(formatGrepResult({ ...base, truncated_by: [] }, false, theme));
	});

	it("展开状态保留 scope 错误和代码区域，但不重复代码正文", () => {
		const output = formatGrepResult({
			...success(),
			paths: ["src", "tests"],
			scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "Directory does not exist." } }],
		}, true, theme);

		for (const value of ["src/auth.ts", "AuthService.login", "missing", "PATH_NOT_FOUND"]) expect(output).toContain(value);
		for (const sourceLine of ["async login", "return secretSession"]) expect(output).not.toContain(sourceLine);
	});

	it("literal fallback 在折叠与展开状态都可区分", () => {
		const base = success();
		const first = base.regions[0];
		if (first === undefined) throw new Error("missing fixture region");
		const details: GrepSuccess = {
			...base,
			query: "read(input",
			query_mode: "literal_fallback",
			regions: [{
				...first,
				matched_by: ["literal"],
				sources: ["text-literal"],
			}],
		};
		const regular = { ...details, query_mode: "regex" as const };
		expect(formatGrepResult(details, false, theme)).not.toBe(formatGrepResult(regular, false, theme));
		expect(formatGrepResult(details, true, theme)).not.toBe(formatGrepResult(regular, true, theme));
	});
});

function success(): GrepSuccess {
	return {
		status: "success",
		query: "authentication flow",
		query_mode: "regex",
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
			roles: ["definition", "defined"],
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
