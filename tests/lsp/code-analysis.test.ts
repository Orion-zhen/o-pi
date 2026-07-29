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
			allowedPaths: ["src.ts", "tests.ts", "ignored.ts"],
			allowRelated: false,
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
		expect(documentSymbols).toHaveBeenCalledTimes(2);
		expect(incomingCalls).toHaveBeenCalledTimes(2);
		expect(references).toHaveBeenCalledTimes(2);
	});

	it("选中 symbol 后即使 documentSymbol 不完整也不返回 unavailable", async () => {
		const sourcePath = path.join(workspace, "src.ts");
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue({
			workspaceSymbolProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
		});
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue(undefined);
		vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue(undefined);
		vi.spyOn(LspClient.prototype, "references").mockResolvedValue(undefined);

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
			root: workspace,
			query: "Target",
			allowedPaths: ["src.ts"],
			allowRelated: false,
			limit: 8,
			async load(relativePath) {
				return { ...document(relativePath, "export function Target() {}\n"), filePath: sourcePath };
			},
		});
		await manager.reload();

		expect(analysis).toEqual({ mode: "symbol", files: [] });
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
			allowedPaths: ["src.ts"],
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
		});
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([workspaceSymbol("Target", sourcePath)]);
		const load = vi.fn(async () => ({ ...document("src.ts", "export function Target() {}\n"), filePath: sourcePath }));

		const manager = new LspManager();
		const analysis = await manager.codeAnalysis({
			root: workspace,
			query: "Target",
			allowedPaths: ["src.ts"],
			allowRelated: false,
			limit: 8,
			load,
		});
		await manager.reload();

		expect(analysis).toBeUndefined();
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
