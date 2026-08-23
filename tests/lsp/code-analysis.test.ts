import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SymbolKind, type ServerCapabilities, type SymbolInformation } from "vscode-languageserver-protocol";

import type { CodeDocument } from "../../src/code-index/types.js";
import { LspClient } from "../../src/lsp/client/client.js";
import { LspManager } from "../../src/lsp/manager/manager.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let configDir: string;
const workspaceTemp = useTempDir("o-pi-lsp-analysis-workspace-");
const configTemp = useTempDir("o-pi-lsp-analysis-config-");
preserveEnv("PI_LSP_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	configDir = configTemp.path;
	const config = path.join(configDir, "lsp.jsonc");
	await writeFile(config, JSON.stringify({
		grep: { workspace_symbols: true, max_symbols: 8, max_exact_leaf_symbols: 2 },
		servers: { fake: { command: ["unused-lsp"], languages: { typescript: "*.ts" } } },
	}));
	process.env.PI_LSP_CONFIG = config;
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
		const documentSymbols = vi.spyOn(LspClient.prototype, "documentSymbols").mockImplementation(async (_filePath) => [
			{
				name: "Target",
				kind: SymbolKind.Function,
				range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
				selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
			},
		]);
		const incomingCalls = vi.spyOn(LspClient.prototype, "incomingCalls").mockImplementation(async (filePath) =>
			filePath === sourcePath
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
				: []);
		const references = vi.spyOn(LspClient.prototype, "references").mockImplementation(async (filePath) =>
			filePath === testPath ? [{ uri: callerUri, range: range() }] : []);
		const documents = new Map<string, CodeDocument>([
			["src.ts", document("src.ts", "export function Target() {\n  return true;\n}\n")],
			["tests.ts", document("tests.ts", "export function Target() {\n  return false;\n}\n")],
		]);

		const analysis = await analyze({
			root: workspace,
			query: "Target",
			targets: ["src.ts", "tests.ts", "ignored.ts"].map((targetPath) => ({ path: targetPath, ranges: [] })),
			allowRelated: true,
			limit: 8,
			async load(relativePath) {
				const value = documents.get(relativePath);
				return value === undefined ? undefined : { ...value, filePath: path.join(workspace, relativePath) };
			},
		});
		expect(analysis?.files.map(({ document: value, analysis: file }) => ({
			path: value.path,
			authority: file.index.units[0]?.authority,
		}))).toEqual([
			{ path: "src.ts", authority: "called" },
			{ path: "tests.ts", authority: "referenced" },
		]);
		expect(analysis?.coveredPaths).toEqual(["src.ts", "tests.ts", "ignored.ts"]);
		expect(documentSymbols).toHaveBeenCalledTimes(2);
		expect(incomingCalls).toHaveBeenCalledTimes(2);
		expect(references).toHaveBeenCalledTimes(2);
	});

	it("选中 symbol 后 documentSymbol 请求失败时原子返回 unavailable", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue(undefined);
		vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue(undefined);
		vi.spyOn(LspClient.prototype, "references").mockResolvedValue(undefined);

		const analysis = await analyze({
			root: workspace,
			query: "Target",
			targets: [{ path: "src.ts", ranges: [{ startByte: 16, endByte: 22 }] }],
			allowRelated: false,
			limit: 8,
			async load(relativePath) {
				return { ...document(relativePath, "export function Target() {}\n"), filePath: sourcePath };
			},
		});
		expect(analysis).toBeUndefined();
	});

	it("同文件但位于目标代码单元之外的 caller 仍形成 called authority", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		const sourceUri = uri(sourcePath);
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([{
			name: "Target",
			kind: SymbolKind.Function,
			range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
			selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
		}]);
		vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue([{
			from: {
				name: "caller",
				kind: SymbolKind.Function,
				uri: sourceUri,
				range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
				selectionRange: { start: { line: 4, character: 9 }, end: { line: 4, character: 15 } },
			},
			fromRanges: [],
		}]);
		vi.spyOn(LspClient.prototype, "references").mockResolvedValue([]);

		const analysis = await analyze({
			root: workspace,
			query: "Target",
			targets: [{ path: "src.ts", ranges: [{ startByte: 16, endByte: 22 }] }],
			allowRelated: false,
			limit: 8,
			async load(relativePath) {
				return {
					...document(relativePath, "export function Target() {\n  return true;\n}\n\nfunction caller() {\n  Target();\n}\n"),
					filePath: sourcePath,
				};
			},
		});
		expect(analysis?.files[0]?.analysis.index.units[0]?.authority).toBe("called");
	});

	it("缺少完整 symbol analysis capability 时保持 unavailable", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		mockCapabilities(["callHierarchyProvider"]);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		const load = vi.fn(async () => ({ ...document("src.ts", "export function Target() {}\n"), filePath: sourcePath }));

		const analysis = await analyze({
			root: workspace,
			query: "Target",
			targets: [{ path: "src.ts", ranges: [{ startByte: 16, endByte: 22 }] }],
			allowRelated: false,
			limit: 8,
			load,
		});
		expect(analysis).toBeUndefined();
		expect(load).not.toHaveBeenCalled();
	});

	it("任一目标文档失败时丢弃其他文档的成功结果", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		const testsPath = path.join(workspace, "tests.ts");
		mockCapabilities(["workspaceSymbolProvider"]);
		const documentSymbols = vi.spyOn(LspClient.prototype, "documentSymbols").mockImplementation(async (filePath) =>
			filePath === sourcePath
				? [{
						name: "Target",
						kind: SymbolKind.Function,
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 35 } },
						selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
					}]
				: undefined);
		vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue([]);
		vi.spyOn(LspClient.prototype, "references").mockResolvedValue([]);

		const analysis = await analyze({
			root: workspace,
			query: "Target",
			targets: [
				{ path: "src.ts", ranges: [{ startByte: 16, endByte: 22 }] },
				{ path: "tests.ts", ranges: [{ startByte: 16, endByte: 22 }] },
			],
			allowRelated: false,
			limit: 8,
			async load(relativePath) {
				return {
					...document(relativePath, "export function Target() { return true; }\n"),
					filePath: relativePath === "src.ts" ? sourcePath : testsPath,
				};
			},
		});
		expect(analysis).toBeUndefined();
		expect(documentSymbols).toHaveBeenCalledTimes(2);
	});

	it("成功结果保持 server 顺序并限制在 target 路径和 symbol 范围内", async () => {
		const config = path.join(configDir, "ordered-lsp.jsonc");
		await writeFile(config, JSON.stringify({
			grep: { workspace_symbols: true, max_symbols: 8, max_exact_leaf_symbols: 2 },
			servers: {
				typescript: { command: ["unused-ts-lsp"], languages: { typescript: "*.ts" } },
				python: { command: ["unused-py-lsp"], languages: { python: "*.py" } },
			},
		}));
		process.env.PI_LSP_CONFIG = config;
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
		vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue([]);
		vi.spyOn(LspClient.prototype, "references").mockResolvedValue([]);

		const analysis = await analyze({
			root: workspace,
			query: "target",
			targets: [{ path: "src.ts", ranges: [] }, { path: "tests.py", ranges: [] }],
			allowRelated: true,
			limit: 8,
			async load(relativePath) {
				return { ...document(relativePath, "\n\nSource\n"), filePath: path.join(workspace, relativePath) };
			},
		});

		expect(analysis?.coveredPaths).toEqual(["src.ts", "tests.py"]);
		expect(analysis?.files.map(({ document: value, analysis: file }) => ({
			path: value.path,
			units: file.index.units.map((unit) => ({ name: unit.name, startLine: unit.startLine, endLine: unit.endLine })),
		}))).toEqual([
			{ path: "src.ts", units: [{ name: "Source", startLine: 3, endLine: 3 }] },
			{ path: "tests.py", units: [{ name: "Tests", startLine: 3, endLine: 3 }] },
		]);
	});

	it("任一 workspace symbol resolve 失败时整次 unavailable", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		mockCapabilities();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([{
			name: "Target",
			kind: SymbolKind.Function,
			location: { uri: uri(sourcePath) },
		}]);
		const resolve = vi.spyOn(LspClient.prototype, "resolveWorkspaceSymbol").mockResolvedValue(undefined);
		const load = vi.fn(async () => ({ ...document("src.ts", "export function Target() {}\n"), filePath: sourcePath }));

		const analysis = await analyze({
			root: workspace,
			query: "Target",
			targets: [{ path: "src.ts", ranges: [] }],
			allowRelated: true,
			limit: 8,
			load,
		});

		expect(analysis).toBeUndefined();
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(load).not.toHaveBeenCalled();
	});

	it("任一 server 的 workspace symbol 请求失败时整次 unavailable", async () => {
		const config = path.join(configDir, "multi-lsp.jsonc");
		await writeFile(config, JSON.stringify({
			grep: { workspace_symbols: true, max_symbols: 8, max_exact_leaf_symbols: 2 },
			servers: {
				typescript: { command: ["unused-ts-lsp"], languages: { typescript: "*.ts" } },
				python: { command: ["unused-py-lsp"], languages: { python: "*.py" } },
			},
		}));
		process.env.PI_LSP_CONFIG = config;
		const sourcePath = path.join(workspace, "src.ts");
		mockCapabilities();
		const workspaceSymbols = vi.spyOn(LspClient.prototype, "workspaceSymbols")
			.mockImplementation(async function(this: LspClient) {
				return this.server.id === "typescript"
					? [workspaceSymbol("Target", sourcePath)]
					: undefined;
			});
		const load = vi.fn(async () => undefined);

		const analysis = await analyze({
			root: workspace,
			query: "Target",
			targets: [
				{ path: "src.ts", ranges: [] },
				{ path: "src.py", ranges: [] },
			],
			allowRelated: true,
			limit: 8,
			load,
		});
		expect(analysis).toBeUndefined();
		expect(workspaceSymbols).toHaveBeenCalledTimes(2);
		expect(load).not.toHaveBeenCalled();
	});
});

const fullCapabilities: ServerCapabilities = {
	workspaceSymbolProvider: true,
	documentSymbolProvider: true,
	referencesProvider: true,
	callHierarchyProvider: true,
};

function mockCapabilities(omitted: readonly (keyof ServerCapabilities)[] = []): void {
	const capabilities = { ...fullCapabilities };
	for (const key of omitted) delete capabilities[key];
	vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
	vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue(capabilities);
}

async function analyze(input: Parameters<LspManager["codeAnalysis"]>[0]) {
	const manager = new LspManager();
	try {
		return await manager.codeAnalysis(input);
	} finally {
		await manager.reload();
	}
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
