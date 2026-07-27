import { describe, expect, it } from "vitest";
import { formatGrepCall, formatGrepResult } from "../../src/file-tools/grep/renderer.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";

const theme = {
	fg(_name: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

describe("grep renderer", () => {
	it("渲染折叠调用和结果摘要", () => {
		const call = formatGrepCall({ query: "authentication flow", path: "src", match: "auto" }, theme);
		expect(call.split("\n")).toHaveLength(2);
		expect(call).toContain('● grep');
		expect(call).toContain('"authentication flow" in src');
		expect(call).toContain("auto");

		const result = formatGrepResult(success(), false, theme);
		expect(result.split("\n")).toHaveLength(2);
		expect(result).toContain('✓ grep');
		expect(result).toContain("1 regions · 1 files · 1 related · 4/4 searched/traversed · limit:token");
	});

	it("多个限制原因在摘要宽度内完整显示", () => {
		const details: GrepSuccess = {
			...success(),
			truncated_by: ["traversal_limit", "text_byte_limit", "semantic_candidate_limit", "result_limit", "token_budget"],
		};
		const summary = formatGrepResult(details, false, theme).split("\n")[1];
		expect(summary).toBeDefined();
		expect(summary?.length).toBeLessThanOrEqual(98);
		expect(summary).toContain("limit:depth,bytes,sem,result,token");
		expect(summary).not.toContain("…");
	});

	it("部分 scope 在摘要和展开结果中明确标注错误", () => {
		const details: GrepSuccess = {
			...success(),
			paths: ["src", "tests"],
			scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "Directory does not exist." } }],
		};
		const collapsed = formatGrepResult(details, false, theme);
		expect(collapsed).toContain("1 scope error");
		expect(collapsed).toContain('"authentication flow" in src, tests');
		const expanded = formatGrepResult(details, true, theme);
		expect(expanded).toContain("Scope errors: missing:PATH_NOT_FOUND.");
	});

	it("展开状态显示区域元数据但不显示源码正文", () => {
		const output = formatGrepResult(success(), true, theme);
		expect(output).toContain("src/auth.ts:4-9 AuthService.login [body; definition; public_api; exact symbol]");
		expect(output).toContain("Related (query match not guaranteed):");
		expect(output).toContain("tests/auth.test.ts:2-6 auth flow [test]");
		expect(output).toContain("limit: token");
		expect(output).not.toContain("async login");
	});

	it("零命中摘要和展开状态显示 nearby 非命中", () => {
		const details: GrepSuccess = {
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
				signature: "function authenticateUser()",
				reason: "symbol similarity",
				query_match: "not_guaranteed",
			}],
		};

		expect(formatGrepResult(details, false, theme)).toContain("0 regions · 0 files · 1 nearby");
		const expanded = formatGrepResult(details, true, theme);
		expect(expanded).toContain("Nearby (query match not guaranteed):");
		expect(expanded).toContain("src/auth.ts:1-3 function authenticateUser() [symbol similarity]");
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
		regions: [
			{
				path: "src/auth.ts",
				start_line: 4,
				end_line: 9,
				kind: "method",
				symbol: "AuthService.login",
				detail: "body",
				query_match: "semantic",
				roles: ["definition", "public_api"],
				reasons: ["exact symbol"],
				sources: ["ast-symbol"],
				content: "async login() {}",
			},
		],
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
