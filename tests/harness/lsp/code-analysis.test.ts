import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SymbolKind, type ServerCapabilities, type SymbolInformation } from "vscode-languageserver-protocol";

import type { CodeAnalysis, CodeDocument } from "../../../src/harness/code-index/types.ts";
import { analyzeCodeFile } from "../../../src/harness/code-index/parser.ts";
import { LspDocumentSession } from "../../../src/harness/lsp/client/document-session.ts";
import { mockDocumentSessions } from "./mock-document-session.ts";
import { LspClient } from "../../../src/harness/lsp/client/client.ts";
import { LspManager } from "../../../src/harness/lsp/manager/manager.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

let workspace: string;
const workspaceTemp = useTempDir("o-pi-lsp-analysis-workspace-");
const configTemp = useTempDir("o-pi-lsp-analysis-config-");
const defaultServers = { fake: { command: ["unused-lsp"], languages: { typescript: "*.ts" } } };
const multiLanguageServers = {
	typescript: { command: ["unused-ts-lsp"], languages: { typescript: "*.ts" } },
	python: { command: ["unused-py-lsp"], languages: { python: "*.py" } },
};
preserveEnv("PI_LSP_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	await writeLspConfig(defaultServers);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("lsp code analysis", () => {
	it("以跨文件 incoming call 和 reference 形成 authority，且只分析受限定义", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		const testPath = path.join(workspace, "tests.ts");
		const callerUri = uri(path.join(workspace, "caller.ts"));
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([
			workspaceSymbol("Target", sourcePath),
			workspaceSymbol("Target", testPath),
			workspaceSymbol("Target", path.join(workspace, "ignored.ts")),
		]);
		const documentSymbols = vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([targetDocumentSymbol()]);
		const incomingCalls = vi.spyOn(LspDocumentSession.prototype, "incomingCalls").mockImplementation(async function(this: LspDocumentSession) { return this.uri === uri(sourcePath)
				? [{
						from: {
							name: "caller",
							kind: SymbolKind.Function,
							uri: callerUri,
							range: range(),
							selectionRange: range(),
						},
						fromRanges: [],
					}]
				: []; });
		const references = vi.spyOn(LspDocumentSession.prototype, "references").mockImplementation(async function(this: LspDocumentSession) {
			return this.uri === uri(testPath) ? [{ uri: callerUri, range: range() }] : []; });
		const documents = new Map<string, CodeDocument>([
			["src.ts", document("src.ts", "export function Target() {\n  return true;\n}\n")],
			["tests.ts", document("tests.ts", "export function Target() {\n  return false;\n}\n")],
			["caller.ts", document("caller.ts", "function caller() { Target(); }\n")],
		]);

		const analysis = await analyze(analysisInput({
			targets: ["src.ts", "tests.ts", "ignored.ts"].map((targetPath) => ({ path: targetPath, ranges: [] })),
			allowRelated: true,
			async load(relativePath) {
				const value = documents.get(relativePath);
				return value === undefined ? undefined : { ...value, filePath: path.join(workspace, relativePath) };
			},
		}));
		expect(analyzedFiles(analysis)?.map(({ document: value, analysis: file }) => ({
			path: value.path,
			authority: file.units[0]?.authority,
		}))).toEqual([
			{ path: "src.ts", authority: "called" },
			{ path: "tests.ts", authority: "referenced" },
		]);
		expect(analysis?.results.map((result) => result.coverage)).toEqual([
			{ path: "src.ts", symbols: "ok", workspaceSymbols: "ok" },
			{ path: "tests.ts", symbols: "ok", workspaceSymbols: "ok" },
			{ path: "ignored.ts", symbols: "skipped", workspaceSymbols: "skipped" },
		]);
		expect(documentSymbols).toHaveBeenCalledTimes(2);
		expect(incomingCalls).toHaveBeenCalledTimes(2);
		expect(references).toHaveBeenCalledTimes(2);
	});

	it("关系分析保留完整导航候选，排除范围外、自引用和失效位置", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		const callerUri = uri(path.join(workspace, "caller.ts"));
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([targetDocumentSymbol(0, 26)]);
		const calls = vi.spyOn(LspDocumentSession.prototype, "incomingCalls").mockResolvedValue([{
			from: { name: "run", kind: SymbolKind.Function, uri: callerUri, range: range(), selectionRange: range() },
			fromRanges: [range(), range()],
		}]);
		const references = vi.spyOn(LspDocumentSession.prototype, "references").mockResolvedValue([
			{ uri: callerUri, range: range() },
			{ uri: callerUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
			{ uri: callerUri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
			{ uri: uri(sourcePath), range: range() },
			{ uri: uri(path.join(workspace, "ignored.ts")), range: range() },
			{ uri: "file:///outside.ts", range: range() },
			{ uri: callerUri, range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } } },
		]);
		const load = vi.fn(async (relativePath: string) => {
			if (relativePath !== "src.ts" && relativePath !== "caller.ts") return undefined;
			return {
				...document(relativePath, relativePath === "src.ts" ? "export function Target() {}\n" : "Target();\nTarget();\nTarget();\n"),
				filePath: path.join(workspace, relativePath),
			};
		});
		const analysis = await analyze(analysisInput({ load }));
		expect(analyzedFiles(analysis)?.[0]?.analysis.units[0]?.navigation).toEqual([
			{ kind: "caller", source: "hierarchy", path: "caller.ts", line: 1, column: 1 },
			{ kind: "reference", source: "references", path: "caller.ts", line: 1, column: 1 },
			{ kind: "reference", source: "references", path: "caller.ts", line: 2, column: 1 },
			{ kind: "reference", source: "references", path: "caller.ts", line: 3, column: 1 },
		]);
		expect(calls).toHaveBeenCalledOnce();
		expect(references).toHaveBeenCalledOnce();
		expect(load).not.toHaveBeenCalledWith("../outside.ts");
	});

	it("关系位置加载期间取消时不提交已完成的部分分析", async () => {
		const controller = new AbortController();
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([targetDocumentSymbol(0, 26)]);
		vi.spyOn(LspDocumentSession.prototype, "incomingCalls").mockResolvedValue([]);
		vi.spyOn(LspDocumentSession.prototype, "references").mockResolvedValue([{ uri: uri(path.join(workspace, "caller.ts")), range: range() }]);
		const result = await analyze(analysisInput({
			signal: controller.signal,
			async load(relativePath) {
				if (relativePath === "caller.ts") controller.abort();
				return {
					...document(relativePath, relativePath === "src.ts" ? "export function Target() {}\n" : "Target();\n"),
					filePath: path.join(workspace, relativePath),
				};
			},
		}));
		expect(result).toBeUndefined();
	});

	it("同文件但位于目标代码单元之外的 caller 仍形成 called authority", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		const sourceUri = uri(sourcePath);
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([targetDocumentSymbol()]);
		vi.spyOn(LspDocumentSession.prototype, "incomingCalls").mockResolvedValue([{
			from: {
				name: "caller",
				kind: SymbolKind.Function,
				uri: sourceUri,
				range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
				selectionRange: { start: { line: 4, character: 9 }, end: { line: 4, character: 15 } },
			},
			fromRanges: [],
		}]);
		vi.spyOn(LspDocumentSession.prototype, "references").mockResolvedValue([]);

		const analysis = await analyze(analysisInput({
			async load(relativePath) {
				return {
					...document(relativePath, "export function Target() {\n  return true;\n}\n\nfunction caller() {\n  Target();\n}\n"),
					filePath: sourcePath,
				};
			},
		}));
		expect(analyzedFiles(analysis)?.[0]?.analysis.units[0]?.authority).toBe("called");
	});

	it.each([false, true])("一台服务器启动失败时保留其他结果，related=%s", async (allowRelated) => {
		await writeLspConfig(multiLanguageServers);
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "ensureReady").mockImplementation(async function(this: LspClient) {
			return this.server.id === "typescript";
		});
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", path.join(workspace, "src.ts"))]);
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([targetDocumentSymbol(0, 26)]);
		vi.spyOn(LspDocumentSession.prototype, "incomingCalls").mockResolvedValue([]);
		vi.spyOn(LspDocumentSession.prototype, "references").mockResolvedValue([]);

		const analysis = await analyze(analysisInput({
			allowRelated,
			targets: ["src.ts", "src.py"].map((path) => ({ path, ranges: allowRelated ? [] : [{ startByte: 16, endByte: 22 }] })),
		}));
		expect(analyzedFiles(analysis)?.map((file) => file.document.path)).toEqual(["src.ts"]);
		expect(analysis?.results.map((result) => result.coverage)).toEqual([
			{ path: "src.ts", symbols: "ok", ...(allowRelated ? { workspaceSymbols: "ok" } : {}) },
			{ path: "src.py", symbols: "unavailable", ...(allowRelated ? { workspaceSymbols: "unavailable" } : {}) },
		]);
	});

	it("成功结果保持 server 顺序并限制在 target 路径和 symbol 范围内", async () => {
		await writeLspConfig(multiLanguageServers);
		const sourcePath = path.join(workspace, "src.ts");
		const testsPath = path.join(workspace, "tests.py");
		const outsidePath = path.join(workspace, "outside.ts");
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockImplementation(async function (this: LspClient) {
			return this.server.id === "typescript"
				? [workspaceSymbol("Source", sourcePath, 2), workspaceSymbol("Outside", outsidePath, 0)]
				: [workspaceSymbol("Tests", testsPath, 2)];
		});
		vi.spyOn(LspClient.prototype, "documentSymbols").mockImplementation(async (filePath) => {
			const name = filePath === sourcePath ? "Source" : "Tests";
			return [{
				name,
				kind: SymbolKind.Function,
				range: { start: { line: 2, character: 0 }, end: { line: 2, character: name.length } },
				selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: name.length } },
			}];
		});
		vi.spyOn(LspDocumentSession.prototype, "incomingCalls").mockResolvedValue([]);
		vi.spyOn(LspDocumentSession.prototype, "references").mockResolvedValue([]);

		const analysis = await analyze(analysisInput({
			query: "target",
			targets: [{ path: "src.ts", ranges: [] }, { path: "tests.py", ranges: [] }],
			allowRelated: true,
			async load(relativePath) {
				return { ...document(relativePath, "\n\nSource\n"), filePath: path.join(workspace, relativePath) };
			},
		}));

		expect(analysis?.results.map((result) => result.coverage)).toEqual(["src.ts", "tests.py"].map((path) => ({ path, symbols: "ok", workspaceSymbols: "ok" })));
		expect(analyzedFiles(analysis)?.map(({ document: value, analysis: file }) => ({
			path: value.path,
			units: file.units.map((unit) => ({ name: unit.name, startLine: unit.startLine, endLine: unit.endLine })),
		}))).toEqual([
			{ path: "src.ts", units: [{ name: "Source", startLine: 3, endLine: 3 }] },
			{ path: "tests.py", units: [{ name: "Tests", startLine: 3, endLine: 3 }] },
		]);
	});

	it("一台服务器的 workspace symbol 失败不影响另一台服务器", async () => {
		await writeLspConfig(multiLanguageServers);
		const sourcePath = path.join(workspace, "src.ts");
		mockCapabilities();
		const workspaceSymbols = vi.spyOn(LspClient.prototype, "workspaceSymbols")
			.mockImplementation(async function(this: LspClient) {
				return this.server.id === "typescript"
					? [workspaceSymbol("Target", sourcePath)]
					: undefined;
			});
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([targetDocumentSymbol(0, 26)]);
		vi.spyOn(LspDocumentSession.prototype, "references").mockResolvedValue([]);
		vi.spyOn(LspDocumentSession.prototype, "incomingCalls").mockResolvedValue([]);
		const load = vi.fn(async (relativePath: string) => ({
			...document(relativePath, "export function Target() {}\n"), filePath: path.join(workspace, relativePath),
		}));

		const analysis = await analyze(analysisInput({
			targets: [
				{ path: "src.ts", ranges: [] },
				{ path: "src.py", ranges: [] },
			],
			allowRelated: true,
			load,
		}));
		expect(analysis?.results.map((result) => result.coverage)).toEqual([
			{ path: "src.ts", symbols: "ok", workspaceSymbols: "ok" },
			{ path: "src.py", symbols: "unavailable", workspaceSymbols: "unavailable" },
		]);
		expect(analyzedFiles(analysis)?.map((file) => file.document.path)).toEqual(["src.ts"]);
		expect(workspaceSymbols).toHaveBeenCalledTimes(2);
		expect(load).toHaveBeenCalledExactlyOnceWith("src.ts");
	});
});

function analyzedFiles(analysis: CodeAnalysis | undefined) {
	return analysis?.results.flatMap(({ file }) => file === undefined ? [] : [file]);
}

const fullCapabilities: ServerCapabilities = {
	workspaceSymbolProvider: { resolveProvider: true },
	documentSymbolProvider: true,
	referencesProvider: true,
	callHierarchyProvider: true,
};

async function writeLspConfig(servers: Record<string, unknown>): Promise<void> {
	const config = path.join(configTemp.path, "lsp.jsonc");
	await writeFile(config, JSON.stringify({
		grep: { workspace_symbols: true, max_symbols: 8, max_exact_leaf_symbols: 2 },
		servers,
	}));
	process.env.PI_LSP_CONFIG = config;
}

function analysisInput(
	overrides: Partial<Parameters<LspManager["codeAnalysis"]>[0]> = {},
): Parameters<LspManager["codeAnalysis"]>[0] {
	return {
		root: workspace,
		syntax: (document) => analyzeCodeFile(document.path, document.text),
		query: "Target",
		targets: [{ path: "src.ts", ranges: [{ startByte: 16, endByte: 22 }] }],
		allowRelated: false,
		limit: 8,
		async load(relativePath) {
			return { ...document(relativePath, "export function Target() {}\n"), filePath: path.join(workspace, relativePath) };
		},
		...overrides,
	};
}

function mockCapabilities(): void {
	mockDocumentSessions();
	vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
	vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue(fullCapabilities);
}

async function analyze(input: Parameters<LspManager["codeAnalysis"]>[0]) {
	const manager = new LspManager();
	try {
		return await manager.codeAnalysis(input);
	} finally {
		await manager.reload();
	}
}

function targetDocumentSymbol(endLine = 2, endCharacter = 1) {
	return {
		name: "Target", kind: SymbolKind.Function,
		range: { start: { line: 0, character: 0 }, end: { line: endLine, character: endCharacter } },
		selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
	};
}

function workspaceSymbol(name: string, filePath: string, line = 0): SymbolInformation {
	return {
		name,
		kind: SymbolKind.Function,
		location: {
			uri: uri(filePath),
			range: { start: { line, character: 0 }, end: { line, character: name.length } },
		},
	};
}

function document(relativePath: string, text: string): CodeDocument {
	return { path: relativePath, text, hash: `hash:${relativePath}` };
}

function range() {
	return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}

function uri(filePath: string): string {
	return pathToFileURL(filePath).toString();
}
