import { describe, expect, it } from "vitest";
import { formatGrepCall, formatGrepResult } from "../../src/file-tools/grep/renderer.js";
import type { GrepSuccess } from "../../src/file-tools/types.js";

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
		expect(result).toContain("1 regions · 1 files · 1 related · symbol+lexical · truncated");
	});

	it("展开状态显示区域元数据但不显示源码正文", () => {
		const output = formatGrepResult(success(), true, theme);
		expect(output).toContain("src/auth.ts:4-9 AuthService.login [body; exact symbol]");
		expect(output).toContain("Related (repo-map; query match not guaranteed):");
		expect(output).toContain("tests/auth.test.ts:2-6 auth flow [test]");
		expect(output).toContain("truncated");
		expect(output).not.toContain("async login");
	});

	it("零命中摘要和展开状态显示 nearby 非命中", () => {
		const details: GrepSuccess = {
			status: "success",
			query: "authentcateUser",
			path: ".",
			match: "auto",
			strategy: ["symbol", "literal", "lexical", "graph"],
			total_candidates: 0,
			returned_regions: 0,
			returned_files: 0,
			approx_tokens: 30,
			scanned_files: 1,
			truncated: false,
			regions: [],
			nearby: [{
				path: "src/auth.ts",
				start_line: 1,
				end_line: 3,
				kind: "function",
				symbol: "authenticateUser",
				signature: "function authenticateUser()",
				reason: "symbol similarity",
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
		strategy: ["symbol", "lexical"],
		total_candidates: 3,
		returned_regions: 1,
		returned_files: 1,
		approx_tokens: 120,
		scanned_files: 4,
		truncated: true,
		regions: [
			{
				path: "src/auth.ts",
				start_line: 4,
				end_line: 9,
				kind: "method",
				symbol: "AuthService.login",
				detail: "body",
				reasons: ["exact symbol"],
				content: "async login() {}",
			},
		],
		related: [{
			path: "tests/auth.test.ts",
			start_line: 2,
			end_line: 6,
			kind: "test",
			symbol: "auth flow",
			source: "repo-map",
			relations: ["test"],
			query_match: "not_guaranteed",
		}],
	};
}
