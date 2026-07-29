import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query, match },
			{ lsp },
		));

		expect(result.regions).toHaveLength(1);
		expect(lsp.query).not.toHaveBeenCalled();
	});

	it("唯一的本地精确符号不会启动 hint", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		const lsp = hintSource([]);

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "Target" },
			{ lsp },
		));

		expect(result.regions[0]).toMatchObject({ path: "target.ts", symbol: "Target" });
		expect(lsp.query).not.toHaveBeenCalled();
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
		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "Target" },
			{ lsp },
		));

		expect(result.regions.map((region) => region.path)).toEqual(["z.ts", "a.ts"]);
		expect(result.regions.flatMap((region) => region.sources)).not.toContain("lsp-symbol");
		expect(lsp.query).toHaveBeenCalledOnce();
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

	it("本地关系不足时请求提示，并把 LSP range 物化为本地 AST region", async () => {
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
		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "references to login" },
			{ lsp },
		));

		expect(maxActive).toBe(1);
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

		const result = expectGrepSuccess(await grepWithHints(
			testContext.workspace,
			{ query: "callers of login" },
			{ lsp },
		));

		expect(result.regions.some((region) => region.roles?.includes("caller") === true)).toBe(true);
		expect(lsp.query).not.toHaveBeenCalled();
	});
});

function hintSource(hints: readonly GrepPositionHint[]): GrepHintSource & { query: ReturnType<typeof vi.fn> } {
	return { query: vi.fn(async () => hints) };
}
