import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AnalyzeCode, CodeAnalysis } from "../../src/code-index/types.js";
import { analyzeCodeFile, type CodeAuthority } from "../../src/code-index/parser.js";
import type { ContentOperations } from "../../src/filesystem/contracts/content.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import {
	createGrepTestContext,
	deferredVoid,
	expectGrepSuccess,
	grepWithAnalyzer,
} from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep code analysis", () => {
	it("正则正文查询优先使用完整 symbol analyzer", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export const value = 'Needle42';\n");
		const analyzeCode = codeAnalyzer([]);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Needle\\d+" },
			{ analyzeCode },
		));

		expect(result.regions).toHaveLength(1);
		expect(result.regions[0]?.kind).toBe("text");
		expect(analyzeCode).toHaveBeenCalledOnce();
	});

	it("唯一正文命中也优先使用完整 symbol analyzer", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		const analyzeCode = codeAnalyzer([]);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ analyzeCode },
		));

		expect(result.regions).toHaveLength(1);
		expect(result.regions[0]?.kind).toBe("text");
		expect(analyzeCode).toHaveBeenCalledOnce();
	});

	it("存在正文命中时 analyzer 只接收真实命中文件，不解析 anchor-only 文件", async () => {
		await writeFile(path.join(testContext.workspace, "a-hit.ts"), "export const exact = 'Authentication Flow';\n");
		await writeFile(path.join(testContext.workspace, "b-anchor.ts"), [
			"export function related() {",
			"  const authentication = true;",
			"  return flow(authentication);",
			"}",
		].join("\n"));
		const targetPaths: string[][] = [];
		const analyzeCode = vi.fn<AnalyzeCode>(async (input) => {
			targetPaths.push(input.targets.map((target) => target.path));
			return undefined;
		});

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Authentication Flow" },
			{ analyzeCode },
		));

		expect(result.regions.map((region) => region.path)).toEqual(["a-hit.ts"]);
		expect(targetPaths).toEqual([["a-hit.ts"]]);
	});

	it("bare CR 正文不进入 LSP，直接回退为安全文本结果", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() {\r  return true;\r}\r");
		const analyzeCode = vi.fn<AnalyzeCode>(async (input) => {
			await expect(input.load("target.ts")).resolves.toBeUndefined();
			return undefined;
		});

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ analyzeCode },
		));

		expect(result.regions[0]?.kind).toBe("text");
		expect(analyzeCode).toHaveBeenCalledOnce();
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

	it("analyzer 抛错时完整回退 Tree-sitter", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function Target() { return false; }\n");
		const analyzeCode = vi.fn<AnalyzeCode>(async () => {
			throw new Error("simulated analyzer failure");
		});

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ analyzeCode },
		));

		expect(result.regions).toHaveLength(2);
		expect(result.regions.every((region) => region.kind === "function")).toBe(true);
		expect(analyzeCode).toHaveBeenCalledOnce();
	});

	it("LSP 失败后的 Tree-sitter 回退复用已加载正文", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function Target() { return false; }\n");
		const analyzeCode = vi.fn<AnalyzeCode>(async (input) => {
			await Promise.all(input.targets.map((target) => input.load(target.path)));
			return undefined;
		});
		let fullReads = 0;

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ analyzeCode },
			(filesystem) => {
				const original = filesystem.content;
				const content: ContentOperations = {
					readBytes: original.readBytes.bind(original),
					async readText(file, options) {
						fullReads += 1;
						return original.readText(file, options);
					},
					decodeText: original.decodeText.bind(original),
					sliceText: original.sliceText.bind(original),
					scanLines: original.scanLines.bind(original),
				};
				return { ...filesystem, content };
			},
		));

		expect(result.regions.every((region) => region.kind === "function")).toBe(true);
		expect(fullReads).toBe(2);
	});

	it("LSP 冷启动与正文扫描重叠执行", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		const releasePreparation = deferredVoid();
		let preparationStarted = false;
		let scanObservedPreparation = false;
		const prepareCodeAnalysis = vi.fn(async () => {
			preparationStarted = true;
			await releasePreparation.promise;
		});
		const analyzeCode = codeAnalyzer([]);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ prepareCodeAnalysis, analyzeCode },
			(filesystem) => {
				const original = filesystem.content;
				const content: ContentOperations = {
					readBytes: original.readBytes.bind(original),
					async readText(file, options) {
						scanObservedPreparation = preparationStarted;
						releasePreparation.resolve();
						return original.readText(file, options);
					},
					decodeText: original.decodeText.bind(original),
					sliceText: original.sliceText.bind(original),
					scanLines: original.scanLines.bind(original),
				};
				return { ...filesystem, content };
			},
		));

		expect(result.regions[0]?.kind).toBe("text");
		expect(scanObservedPreparation).toBe(true);
		expect(prepareCodeAnalysis).toHaveBeenCalledWith({
			paths: ["target.ts"],
			signal: expect.any(AbortSignal),
		});
	});

	it.each([
		{
			language: "TypeScript",
			extension: "ts",
			query: "Target",
			target: "export function Target() { return true; }\n",
			alternate: "export function Target() { return false; }\n",
			consumer: "import { Target } from './engine';\nexport function run() { return Target(); }\n",
		},
		{
			language: "Python",
			extension: "py",
			query: "Target",
			target: "def Target():\n  return True\n",
			alternate: "def Target():\n  return False\n",
			consumer: "from engine import Target\n\ndef run():\n  return Target()\n",
		},
		{
			language: "Rust",
			extension: "rs",
			engineDirectory: "src",
			query: "target",
			target: "pub fn target() -> bool { true }\n",
			alternate: "pub fn target() -> bool { false }\n",
			consumer: "use crate::engine::target;\npub fn run() -> bool { target() }\n",
		},
		{
			language: "C",
			extension: "c",
			query: "Target",
			target: "int Target(void) { return 1; }\n",
			alternate: "int Target(void) { return 0; }\n",
			consumer: "#include \"engine.c\"\nint run(void) { return Target(); }\n",
		},
	])("LSP unavailable 时由 $language import/call 关系提升唯一目标定义", async ({
		extension,
		engineDirectory,
		query,
		target,
		alternate,
		consumer,
	}) => {
		const enginePath = engineDirectory === undefined
			? `engine.${extension}`
			: `${engineDirectory}/engine.${extension}`;
		const samplePath = `sample.${extension}`;
		if (engineDirectory !== undefined) await mkdir(path.join(testContext.workspace, engineDirectory));
		await writeFile(path.join(testContext.workspace, enginePath), target);
		await writeFile(path.join(testContext.workspace, samplePath), alternate);
		await writeFile(
			path.join(testContext.workspace, `consumer.${extension}`),
			consumer,
		);
		const analyzeCode = vi.fn<AnalyzeCode>(async () => undefined);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query },
			{ analyzeCode },
		));

		const engine = result.regions.find((region) => region.path === enginePath && region.roles?.includes("definition") === true);
		const sample = result.regions.find((region) => region.path === samplePath && region.roles?.includes("definition") === true);
		expect(engine?.roles).toEqual(["definition", "called"]);
		expect(sample?.roles).toEqual(["definition", "defined"]);
		expect(result.regions.findIndex((region) => region === engine))
			.toBeLessThan(result.regions.findIndex((region) => region === sample));
		expect(analyzeCode).toHaveBeenCalledOnce();
	});

	it("Tree-sitter 不把被局部定义遮蔽的同名调用连接到外部定义", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function Target() { return true; }\n");
		await writeFile(
			path.join(testContext.workspace, "consumer.ts"),
			"export function run() { const Target = () => false; return Target(); }\n",
		);
		const analyzeCode = vi.fn<AnalyzeCode>(async () => undefined);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Target" },
			{ analyzeCode },
		));

		const target = result.regions.find((region) => region.path === "target.ts");
		expect(target?.roles).toEqual(["definition", "defined"]);
	});

	it("Tree-sitter 将显式 import 后的非调用使用标记为 referenced", async () => {
		await writeFile(path.join(testContext.workspace, "value.ts"), "export const Token = 1;\n");
		await writeFile(path.join(testContext.workspace, "alternate.ts"), "export const Token = 2;\n");
		await writeFile(
			path.join(testContext.workspace, "consumer.ts"),
			"import { Token } from './value';\nexport const selected = Token;\n",
		);
		const analyzeCode = vi.fn<AnalyzeCode>(async () => undefined);

		const result = expectGrepSuccess(await grepWithAnalyzer(
			testContext.workspace,
			{ query: "Token" },
			{ analyzeCode },
		));

		const value = result.regions.find((region) => region.path === "value.ts" && region.roles?.includes("definition") === true);
		const alternate = result.regions.find((region) => region.path === "alternate.ts");
		expect(value?.roles).toEqual(["definition", "referenced"]);
		expect(alternate?.roles).toEqual(["definition", "defined"]);
	});

	it("Tree-sitter authority 推断不污染跨调用复用的 AST cache", async () => {
		await writeFile(path.join(testContext.workspace, "engine.ts"), "export function Target() { return true; }\n");
		await writeFile(
			path.join(testContext.workspace, "consumer.ts"),
			"import { Target } from './engine';\nexport function run() { return Target(); }\n",
		);

		const linked = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Target" }));
		expect(linked.regions.find((region) => region.path === "engine.ts")?.roles)
			.toEqual(["definition", "called"]);

		const isolated = expectGrepSuccess(await grepWorkspaceFiles(
			testContext.workspace,
			{ path: ["engine.ts"], query: "Target" },
		));
		expect(isolated.regions[0]?.roles).toEqual(["definition", "defined"]);
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
		return { mode: "symbol", coveredPaths: input.targets.map((target) => target.path), files: analyzed };
	});
}
