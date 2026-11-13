import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AnalyzeCode, CodeAuthority, CodeNavigation } from "../../../src/harness/code-index/types.ts";
import { formatCompactGrepResult } from "../../../src/harness/file-tools/grep/command.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { grepWorkspaceFiles } from "../../helpers/grep-tool.ts";
import { createGrepTestContext, expectGrepSuccess, grepWithAnalyzer, overrideContent } from "./grep-fixtures.ts";

const testContext = createGrepTestContext();

describe("grep code analysis", () => {
	it("存在正文命中时只增强命中文件，不解析词法相关文件", async () => {
		await writeFile(path.join(testContext.workspace, "hit.ts"), "export const exact = 'Authentication Flow';\n");
		await writeFile(path.join(testContext.workspace, "related.ts"), "export function related() { return flow(authentication); }\n");
		let targets: readonly string[] = [];
		const analyzeCode: AnalyzeCode = async (input) => {
			targets = input.targets.map((target) => target.path);
			return undefined;
		};

		const result = await analyzeGrep("Authentication Flow", { analyzeCode });
		expect(result.regions.map((region) => region.path)).toEqual(["hit.ts"]);
		expect(targets).toEqual(["hit.ts"]);
	});

	it("bare CR 正文不提供给 LSP，保留文本命中", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() {\r  return true;\r}\r");
		let supplied = false;
		const result = await analyzeGrep("Target", { analyzeCode: async (input) => {
			supplied = await input.load("target.ts") !== undefined;
			return undefined;
		} });
		expect(supplied).toBe(false);
		expect(result.regions).toMatchObject([{ kind: "text", match_lines: [1] }]);
	});

	it("已确认的调用证据使定义优先，目录名不决定等级", async () => {
		await writeFile(path.join(testContext.workspace, "src.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "tests.ts"), "export function Target() { return false; }\n");
		const result = await analyzeGrep("Target", { analyzeCode: codeAnalyzer([
			{ path: "src.ts", authority: "called" }, { path: "tests.ts", authority: "defined" },
		]) });
		expect(result.regions).toMatchObject([
			{ path: "src.ts", roles: ["definition", "called"] },
			{ path: "tests.ts", roles: ["definition", "defined"] },
		]);
	});

	it("只有前四个区域附加两类导航，导航不计入正文命中", async () => {
		const navigation: CodeNavigation[] = [
			{ kind: "reference", source: "references", path: "a.ts", line: 1, column: 1 },
			{ kind: "caller", source: "hierarchy", path: "c.ts", line: 1, column: 1, ambiguous: true },
			{ kind: "caller", source: "hierarchy", path: "a.ts", line: 1, column: 1 },
			{ kind: "caller", source: "hierarchy", path: "b.ts", line: 1, column: 1 },
			{ kind: "callee", source: "definition", path: "d.ts", line: 1, column: 1 },
		];
		const files = Array.from({ length: 6 }, (_, index) => ({ path: `target-${index}.ts`, authority: "called" as const, navigation }));
		await Promise.all(files.map((file) => writeFile(path.join(testContext.workspace, file.path), "export function Target() {}\n")));
		const result = await analyzeGrep("Target", { analyzeCode: codeAnalyzer(files) });
		for (const region of result.regions.slice(0, 4)) expect(region.navigation).toEqual([navigation[2], navigation[4]]);
		expect(result.regions.slice(4).every((region) => region.navigation === undefined)).toBe(true);
		expect(result.regions.every((region) => region.match_lines?.length === 1)).toBe(true);
		expect(formatCompactGrepResult(result).match(/caller: a.ts:1:1/gu)).toHaveLength(4);
	});

	it("并发辅助文件读取不重复 I/O，增强异常后仍返回基础结构", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "caller.ts"), "export function run() { return 1; }\n");
		let fullReads = 0;
		let symbols: Array<string | undefined> = [];
		const analyzeCode: AnalyzeCode = async (input) => {
			const documents = await Promise.all(Array.from({ length: 4 }, () => input.load("caller.ts")));
			const analyses = await Promise.all(documents.map((document) => {
				if (document === undefined) throw new Error("missing caller document");
				return input.syntax(document);
			}));
			symbols = analyses.flatMap((analysis) => analysis.units.map((unit) => unit.name));
			throw new Error("analysis unavailable");
		};
		const result = await analyzeGrep("Target", { analyzeCode }, (filesystem) => overrideContent(filesystem, (content) => ({
			async readText(file, options) {
				fullReads += 1;
				return content.readText(file, options);
			},
		})));
		expect(fullReads).toBe(2);
		expect(symbols).toEqual(["run", "run", "run", "run"]);
		expect(result.regions).toMatchObject([{ path: "target.ts", kind: "function" }]);
	});

	it("LSP 预热与正文扫描重叠，分析不等待预热完成", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		const releasePreparation = deferredVoid();
		let preparationStarted = false;
		let scanObservedPreparation = false;
		const result = await analyzeGrep("Target", {
			async prepareCodeAnalysis() {
				preparationStarted = true;
				await releasePreparation.promise;
			},
			async analyzeCode(input) {
				releasePreparation.resolve();
				return codeAnalyzer([])(input);
			},
		}, (filesystem) => overrideContent(filesystem, (content) => ({
			async readText(file, options) {
				scanObservedPreparation = preparationStarted;
				return content.readText(file, options);
			},
		})));
		expect(result.regions[0]?.kind).toBe("function");
		expect(scanObservedPreparation).toBe(true);
	});

	it("没有 LSP 证据时，导入、同名引用和局部调用不提升定义等级", async () => {
		for (const file of ["engine.ts", "alternate.ts"]) {
			await writeFile(path.join(testContext.workspace, file), "export function Target() { return true; }\nexport const Token = 1;\n");
		}
		await writeFile(path.join(testContext.workspace, "consumer.ts"),
			"import { Target, Token } from './engine';\nexport function run() { const Target = () => false; return Target() + Token; }\n");
		const result = await analyzeGrep("Target|Token", { analyzeCode: async () => undefined });
		const definitions = result.regions.filter((region) => region.path === "engine.ts" || region.path === "alternate.ts");
		expect(definitions).toHaveLength(4);
		expect(definitions.every((region) => region.roles?.join(",") === "definition,defined")).toBe(true);
		expect(result.regions.every((region) => region.navigation === undefined)).toBe(true);
	});

	it("语义关系等级不污染跨调用复用的语法缓存", async () => {
		await writeFile(path.join(testContext.workspace, "engine.ts"), "export function Target() { return true; }\n");
		const linked = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Target" }, undefined, {
			lsp: { codeAnalysis: codeAnalyzer([{ path: "engine.ts", authority: "called" }]) },
		}));
		expect(linked.regions[0]?.roles).toEqual(["definition", "called"]);
		const isolated = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["engine.ts"], query: "Target" }));
		expect(isolated.regions[0]?.roles).toEqual(["definition", "defined"]);
	});
});

async function analyzeGrep(
	query: string,
	sources: Parameters<typeof grepWithAnalyzer>[2],
	mapFilesystem?: Parameters<typeof grepWithAnalyzer>[3],
) {
	return expectGrepSuccess(await grepWithAnalyzer(testContext.workspace, { query }, sources, mapFilesystem));
}

function codeAnalyzer(files: readonly { path: string; authority: CodeAuthority; navigation?: readonly CodeNavigation[] }[]): AnalyzeCode {
	return async (input) => {
		const analyzed = await Promise.all(files.map(async (file) => {
			const document = await input.load(file.path);
			if (document === undefined) throw new Error(`missing analyzer document: ${file.path}`);
			const parsed = await input.syntax(document);
			return {
				hash: document.hash,
				selectedIds: parsed.units.map((unit) => `lsp:${unit.id}`),
				analysis: {
					...parsed,
					units: parsed.units.map((unit) => ({
						...unit, id: `lsp:${unit.id}`, authority: file.authority,
						symbol: { type: "document" as const, range: unit, selection: unit.syntax?.nameRange ?? unit },
						...(file.navigation === undefined ? {} : { navigation: file.navigation }),
					})),
				},
			};
		}));
		return { relations: [], results: input.targets.map((target) => {
			const file = analyzed.find((file) => file.analysis.path === target.path);
			return { coverage: { path: target.path, symbols: "ok" }, ...(file === undefined ? {} : { file }) };
		}) };
	};
}
