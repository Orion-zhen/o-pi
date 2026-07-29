import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AnalyzeCode, CodeAnalysis } from "../../src/code-index/types.js";
import { analyzeCodeFile, type CodeAuthority } from "../../src/code-index/parser.js";
import { createGrepTestContext, expectGrepSuccess, grepWithAnalyzer } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep code analysis", () => {
	it("正则正文查询不启动 symbol analyzer", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export const value = 'Needle42';\n");
		const analyzeCode = codeAnalyzer([]);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Needle\\d+" },
			{ analyzeCode },
		));

		expect(result.regions).toHaveLength(1);
		expect(analyzeCode).not.toHaveBeenCalled();
	});

	it("唯一正文命中没有排序歧义时不启动 symbol analyzer", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		const analyzeCode = codeAnalyzer([]);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ analyzeCode },
		));

		expect(result.regions).toHaveLength(1);
		expect(analyzeCode).not.toHaveBeenCalled();
	});

	it("LSP authority 在不读取路径语义时将被调用定义排在测试定义之前", async () => {
		await writeFile(path.join(testContext.workspace, "src.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "tests.ts"), "export function Target() { return false; }\n");
		const analyzeCode = codeAnalyzer([
			{ path: "src.ts", authority: "called" },
			{ path: "tests.ts", authority: "defined" },
		]);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ analyzeCode },
		));

		expect(result.regions.map((region) => region.path)).toEqual(["src.ts", "tests.ts"]);
		expect(result.regions.map((region) => region.roles)).toEqual([
			["definition", "called"],
			["definition", "defined"],
		]);
		expect(analyzeCode).toHaveBeenCalledOnce();
	});

	it("零正文命中时直接使用 analyzer 返回的 related symbol", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export function authenticate() { return true; }\n");
		const analyzeCode = codeAnalyzer([{ path: "auth.ts", authority: "referenced" }]);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "authentcate" },
			{ analyzeCode },
		));

		expect(result.regions).toEqual([
			expect.objectContaining({
				path: "auth.ts",
				symbol: "authenticate",
				query_match: "semantic",
				roles: ["definition", "referenced"],
				matched_by: ["related"],
			}),
		]);
		expect(analyzeCode).toHaveBeenCalledOnce();
	});
});

function codeAnalyzer(
	files: readonly { readonly path: string; readonly authority: CodeAuthority }[],
): ReturnType<typeof vi.fn<AnalyzeCode>> {
	return vi.fn<AnalyzeCode>(async (input): Promise<CodeAnalysis> => {
		const analyzed = await Promise.all(files.map(async (file) => {
			const document = await input.load(file.path);
			if (document === undefined) throw new Error(`missing analyzer document: ${file.path}`);
			const parsed = await analyzeCodeFile(file.path, document.text);
			return {
				document,
				analysis: {
					...parsed,
					index: {
						...parsed.index,
						units: parsed.index.units.map((unit) => ({ ...unit, authority: file.authority })),
					},
				},
			};
		}));
		return { mode: "symbol", files: analyzed };
	});
}
