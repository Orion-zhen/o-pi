import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { formatCompactGrepResult } from "../../src/file-tools/grep/command.js";
import type { GrepHintSource, GrepPositionHint } from "../../src/file-tools/grep/ports.js";
import {
	createGrepTestContext,
	expectGrepSuccess,
	grepWithHints,
} from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep position hints", () => {
	it.each([
		{ match: "literal" as const, query: "Needle42" },
		{ match: "regex" as const, query: "Needle\\d+" },
	])("$match 只执行本地事实链", async ({ match, query }) => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export const value = 'Needle42';\n");
		const lsp = hintSource([]);
		const repoMap = hintSource([]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query, match },
			{ lsp, repoMap },
		));

		expect(result.regions).toHaveLength(1);
		expect(lsp.query).not.toHaveBeenCalled();
		expect(repoMap.query).not.toHaveBeenCalled();
	});

	it("唯一的本地精确符号不会启动 hint", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		const lsp = hintSource([]);
		const repoMap = hintSource([]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "Target" },
			{ lsp, repoMap },
		));

		expect(result.regions[0]).toMatchObject({ path: "target.ts", symbol: "Target" });
		expect(lsp.query).not.toHaveBeenCalled();
		expect(repoMap.query).not.toHaveBeenCalled();
	});

	it("LSP 只在本地精确符号歧义时改善位置顺序", async () => {
		for (const name of ["a.ts", "z.ts"]) {
			await writeFile(path.join(testContext.workspace, name), "export function Target() { return true; }\n");
		}
		const lsp = hintSource([{
			path: "z.ts",
			range: { startLine: 1, endLine: 1 },
			origin: "lsp-symbol",
			confidence: 1,
			relation: "definition",
			reasons: ["lsp exact symbol"],
		}]);
		const repoMap = hintSource([]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "Target" },
			{ lsp, repoMap },
		));

		expect(result.regions.map((region) => region.path)).toEqual(["z.ts", "a.ts"]);
		expect(result.regions.flatMap((region) => region.sources)).not.toContain("lsp-symbol");
		expect(lsp.query).toHaveBeenCalledOnce();
		expect(repoMap.query).not.toHaveBeenCalled();
	});

	it("LSP 提示不能把无关 live AST unit 伪造成结果", async () => {
		for (const [name, symbol] of [["a.ts", "Target"], ["b.ts", "Target"], ["unrelated.ts", "Other"]] as const) {
			await writeFile(path.join(testContext.workspace, name), `export function ${symbol}() { return true; }\n`);
		}
		const lsp = hintSource([{
			path: "unrelated.ts",
			range: { startLine: 1, endLine: 1 },
			origin: "lsp-symbol",
			confidence: 1,
			relation: "definition",
			reasons: ["lsp exact symbol"],
		}]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "Target" },
			{ lsp },
		));

		expect(result.regions.map((region) => region.path)).not.toContain("unrelated.ts");
	});

	it("Repo Map 零结果后备只能选择并展示本地 AST 内容", async () => {
		const content = "export function authenticateRequest() { return true; }\n";
		await writeFile(path.join(testContext.workspace, "auth.ts"), content);
		const repoMap = hintSource([{
			path: "auth.ts",
			range: { startLine: 1, endLine: 1 },
			origin: "repo-map",
			confidence: 1,
			contentHash: createHash("sha256").update(content).digest("hex"),
			relation: "definition",
			reasons: ["component"],
		}]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "where credentials are checked" },
			{ repoMap },
		));

		expect(result.regions).toEqual([
			expect.objectContaining({
				path: "auth.ts",
				symbol: "authenticateRequest",
				declaration: expect.stringContaining("authenticateRequest"),
				query_match: "semantic",
					sources: ["ast-symbol"],
			}),
		]);
		expect(formatCompactGrepResult(result)).not.toContain("repo-map");
		expect(repoMap.query).toHaveBeenCalledOnce();
	});

	it("过期 Repo Map hash 不能选择本地位置", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export function authenticateRequest() {}\n");
		const repoMap = hintSource([{
			path: "auth.ts",
			range: { startLine: 1, endLine: 1 },
			origin: "repo-map",
			confidence: 1,
			contentHash: "stale",
			relation: "definition",
			reasons: ["component"],
		}]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "where credentials are checked" },
			{ repoMap },
		));

		expect(result.regions).toEqual([]);
	});

	it("Repo Map hop-1 不会作为普通查询主结果回流", async () => {
		await writeFile(path.join(testContext.workspace, "neighbor.ts"), "export function neighboringHelper() {}\n");
		const repoMap = hintSource([{
			path: "neighbor.ts",
			range: { startLine: 1, endLine: 1 },
			origin: "repo-map",
			confidence: 1,
			hop: 1,
			reasons: ["calls"],
		}]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "where credentials are checked" },
			{ repoMap },
		));

		expect(result.regions).toEqual([]);
		expect(repoMap.query).toHaveBeenCalledOnce();
	});

	it("本地关系不足时并发请求提示，并把 LSP range 物化为本地 AST region", async () => {
		await writeFile(path.join(testContext.workspace, "caller.ts"), "export function caller() { return true; }\n");
		let active = 0;
		let maxActive = 0;
		const delayed = async (hints: readonly GrepPositionHint[]): Promise<readonly GrepPositionHint[]> => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active -= 1;
			return hints;
		};
		const lsp: GrepHintSource = {
			query: vi.fn(async () => await delayed([{
				path: "caller.ts",
				range: { startLine: 1, endLine: 1 },
					origin: "lsp-reference",
				confidence: 1,
				relation: "reference",
				reasons: ["lsp reference"],
			}])),
		};
		const repoMap: GrepHintSource = { query: vi.fn(async () => await delayed([])) };

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "references to login" },
			{ lsp, repoMap },
		));

		expect(maxActive).toBe(2);
		expect(result.regions).toEqual([
			expect.objectContaining({
				path: "caller.ts",
				symbol: "caller",
				roles: ["reference"],
					sources: ["ast-symbol"],
			}),
		]);
	});

	it("本地关系已经足够时不会请求 hint", async () => {
		await writeFile(path.join(testContext.workspace, "caller.ts"), "export function caller() { return login(); }\n");
		const lsp = hintSource([]);
		const repoMap = hintSource([]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "callers of login" },
			{ lsp, repoMap },
		));

		expect(result.regions.some((region) => region.roles?.includes("caller") === true)).toBe(true);
		expect(lsp.query).not.toHaveBeenCalled();
		expect(repoMap.query).not.toHaveBeenCalled();
	});
});

function hintSource(hints: readonly GrepPositionHint[]): GrepHintSource & { query: ReturnType<typeof vi.fn> } {
	return { query: vi.fn(async () => hints) };
}
