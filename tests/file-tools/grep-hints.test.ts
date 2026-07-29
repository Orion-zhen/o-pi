import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { GrepHintSource, GrepPositionHint } from "../../src/file-tools/grep/ports.js";
import { createGrepTestContext, expectGrepSuccess, grepWithHints } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep position hints", () => {
	it.each(["Needle42", "Needle\\d+"])("正文命中 %s 不启动 related hint", async (query) => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export const value = 'Needle42';\n");
		const lsp = hintSource([]);

		const result = expectGrepSuccess(await grepWithHints(testContext.workspace, { query }, { lsp }));

		expect(result.regions).toHaveLength(1);
		expect(lsp.query).not.toHaveBeenCalled();
	});

	it("唯一的本地精确符号不会启动 hint", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		const lsp = hintSource([]);

		const result = expectGrepSuccess(await grepWithHints(testContext.workspace, { query: "Target" }, { lsp }));

		expect(result.regions[0]).toMatchObject({ path: "target.ts", symbol: "Target" });
		expect(lsp.query).not.toHaveBeenCalled();
	});

	it("多个本地精确符号使用 LSP 位置证据消歧", async () => {
		for (const name of ["a.ts", "z.ts"]) {
			await writeFile(path.join(testContext.workspace, name), "export function Target() { return true; }\n");
		}
		const lsp = hintSource([{
			path: "z.ts",
			range: { startLine: 1, endLine: 1 },
			origin: "lsp-symbol",
			confidence: 1,
			reasons: ["lsp exact symbol"],
		}]);

		const result = expectGrepSuccess(await grepWithHints(testContext.workspace, { query: "Target" }, { lsp }));

		expect(result.regions.map((region) => region.path)).toEqual(["z.ts", "a.ts"]);
		expect(result.regions[0]?.sources).toContain("lsp-symbol");
		expect(result.regions[1]?.sources).not.toContain("lsp-symbol");
		expect(lsp.query).toHaveBeenCalledOnce();
	});

	it("零正文命中时将 LSP symbol 映射为 related live AST region", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export function authenticate() { return true; }\n");
		const lsp = hintSource([{
			path: "auth.ts",
			range: { startLine: 1, endLine: 1 },
			origin: "lsp-symbol",
			confidence: 0.8,
			reasons: ["workspace symbol"],
		}]);

		const result = expectGrepSuccess(await grepWithHints(testContext.workspace, { query: "authentcate" }, { lsp }));

		expect(result.regions).toEqual([
			expect.objectContaining({
				path: "auth.ts",
				symbol: "authenticate",
				query_match: "semantic",
				matched_by: ["related"],
				sources: ["lsp-symbol"],
			}),
		]);
		expect(lsp.query).toHaveBeenCalledOnce();
	});
});

function hintSource(hints: readonly GrepPositionHint[]): GrepHintSource & { query: ReturnType<typeof vi.fn> } {
	return { query: vi.fn(async () => hints) };
}
