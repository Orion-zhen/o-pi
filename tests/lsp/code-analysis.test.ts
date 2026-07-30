import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SymbolKind, type SymbolInformation } from "vscode-languageserver-protocol";

import type { CodeDocument } from "../../src/code-index/types.js";
import { LspClient } from "../../src/lsp/client.js";
import { LspManager } from "../../src/lsp/manager.js";
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
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue({
			workspaceSymbolProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			callHierarchyProvider: true,
		});
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

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
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
		await manager.reload();

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
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue({
			workspaceSymbolProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			callHierarchyProvider: true,
		});
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue(undefined);
		vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue(undefined);
		vi.spyOn(LspClient.prototype, "references").mockResolvedValue(undefined);

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
			root: workspace,
			query: "Target",
			targets: [{ path: "src.ts", ranges: [{ startByte: 16, endByte: 22 }] }],
			allowRelated: false,
			limit: 8,
			async load(relativePath) {
				return { ...document(relativePath, "export function Target() {}\n"), filePath: sourcePath };
			},
		});
		await manager.reload();

		expect(analysis).toBeUndefined();
	});

	it("同文件但位于目标代码单元之外的 caller 仍形成 called authority", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		const sourceUri = uri(sourcePath);
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue({
			workspaceSymbolProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			callHierarchyProvider: true,
		});
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

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
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
		await manager.reload();

		expect(analysis?.files[0]?.analysis.index.units[0]?.authority).toBe("called");
	});

	it("缺少完整 symbol analysis capability 时保持 unavailable", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue({
			workspaceSymbolProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
		});
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		const load = vi.fn(async () => ({ ...document("src.ts", "export function Target() {}\n"), filePath: sourcePath }));

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
			root: workspace,
			query: "Target",
			targets: [{ path: "src.ts", ranges: [{ startByte: 16, endByte: 22 }] }],
			allowRelated: false,
			limit: 8,
			load,
		});
		await manager.reload();

		expect(analysis).toBeUndefined();
		expect(load).not.toHaveBeenCalled();
	});

	it("任一目标文档失败时丢弃其他文档的成功结果", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		const testsPath = path.join(workspace, "tests.ts");
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue({
			documentSymbolProvider: true,
			referencesProvider: true,
			callHierarchyProvider: true,
		});
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

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
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
		await manager.reload();

		expect(analysis).toBeUndefined();
		expect(documentSymbols).toHaveBeenCalledTimes(2);
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
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue({
			workspaceSymbolProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			callHierarchyProvider: true,
		});
		const workspaceSymbols = vi.spyOn(LspClient.prototype, "workspaceSymbols")
			.mockImplementation(async function(this: LspClient) {
				return this.server.id === "typescript"
					? [workspaceSymbol("Target", sourcePath)]
					: undefined;
			});
		const load = vi.fn(async () => undefined);

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
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
		await manager.reload();

		expect(analysis).toBeUndefined();
		expect(workspaceSymbols).toHaveBeenCalledTimes(2);
		expect(load).not.toHaveBeenCalled();
	});
});

function workspaceSymbol(name: string, filePath: string): SymbolInformation {
	return {
		name,
		kind: SymbolKind.Function,
		location: {
			uri: uri(filePath),
			range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
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
