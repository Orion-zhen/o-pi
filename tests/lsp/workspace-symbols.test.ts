import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerCapabilities, SymbolInformation } from "vscode-languageserver-protocol";

import { LspClient } from "../../src/lsp/client/client.js";
import { LspManager } from "../../src/lsp/manager/manager.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let configDir: string;
const workspaceTemp = useTempDir("o-pi-lsp-symbol-workspace-");
const configTemp = useTempDir("o-pi-lsp-symbol-config-");
preserveEnv("PI_LSP_CONFIG");

beforeEach(() => {
	workspace = workspaceTemp.path;
	configDir = configTemp.path;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const fullCapabilities: ServerCapabilities = {
	workspaceSymbolProvider: { resolveProvider: true },
	documentSymbolProvider: true,
	referencesProvider: true,
	callHierarchyProvider: true,
};

const documentSymbolNames = [
	"Target",
	"parse",
	"ComposeTarget",
	"YamlTarget",
	"WrongService",
	"DuplicateCompose",
	"outside",
	"fail",
	"good",
	"complete",
	"extra",
	"tsFirst",
	"pySecond",
	"target",
];

describe("lsp workspace symbols through code analysis", () => {
	it("root 命中 exclude_paths 时不启动 LSP", async () => {
		await writeConfig({
			enabled: true,
			exclude_paths: [workspace],
			servers: { fake: testServer("missing-lsp", ["ts"]) },
		});
		await withManager(async (manager) => {
			await expect(queryWorkspaceSymbols(manager, "target")).resolves.toEqual([]);
			await expect(manager.didWriteBatch([{ root: workspace, filePath: path.join(workspace, "a.ts"), text: "const x = 1;\n" }])).resolves.toEqual([undefined]);
			await expect(manager.status(workspace)).resolves.toMatchObject({ enabled: false, servers: [] });
		});
	});

	it("server binary 缺失时退化为 unavailable", async () => {
		await writeConfig({
			enabled: true,
			startup_timeout_ms: 200,
			servers: { missing: testServer("definitely-missing-o-pi-lsp", ["ts"]) },
		});
		const status = await withManager(async (manager) => {
			await expect(queryWorkspaceSymbols(manager, "target")).resolves.toEqual([]);
			return manager.status(workspace);
		});
		expect(status.servers[0]).toMatchObject({ id: "missing", status: "unavailable" });
		expect(status.servers[0]?.last_error).toMatch(/failed to start|ENOENT/);
	});

	it("workspace symbols 按 scope 文件 selector 路由且空 scope 不启动 server", async () => {
		await writeConfig({
			servers: {
				ts: testServer("unused-ts", ["ts"]),
				python: testServer("unused-python", ["py"]),
				disabled: testServer("unused-go", ["go"], false),
			},
		});
		const requests: string[] = [];
		mockReady();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockImplementation(async function (this: LspClient) {
			requests.push(this.server.id);
			return [];
		});

		await withManager(async (manager) => {
			await expect(queryWorkspaceSymbols(manager, "target", ["src/target.ts"])).resolves.toEqual([]);
			await expect(queryWorkspaceSymbols(manager, "target", ["src/target.ts", "src/target.py"])).resolves.toEqual([]);
			await expect(queryWorkspaceSymbols(manager, "target", [])).resolves.toEqual([]);
			await expect(queryWorkspaceSymbols(manager, "target", ["src/target.go"])).resolves.toEqual([]);
		});

		expect(requests).toEqual(["ts", "ts", "python"]);
	});

	it("outline 关闭且不需要 enclosing symbol 时不启动 client", async () => {
		await writeConfig({
			read: { outline: false, max_symbols: 40 },
			servers: { fake: testServer("unused", ["ts"]) },
		});
		const ensureReady = mockReady();
		const documentSymbols = vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([]);

		const result = await withManager((manager) => manager.readEnhancement(
			workspace,
			path.join(workspace, "a.ts"),
			"const value = 1;\n",
			{ startLine: 1, endLine: 1 },
			{ outline: true, enclosing: false },
		));

		expect(result).toBeUndefined();
		expect(ensureReady).not.toHaveBeenCalled();
		expect(documentSymbols).not.toHaveBeenCalled();
	});

	it("workspace symbol 按配置限制同名 exact leaf", async () => {
		await writeConfig({
			enabled: true,
			grep: { workspace_symbols: true, max_symbols: 10, max_exact_leaf_symbols: 2 },
			servers: { fake: testServer("unused-lsp", ["ts"]) },
		});
		mockReady();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([
			0, 1, 2, 3,
		].map((index) => ({
			name: "Target",
			kind: 12,
			location: { uri: pathToUri(path.join(workspace, "src", `target${index}.ts`)), range: range(index) },
		})));

		const hits = await withManager((manager) => queryWorkspaceSymbols(
			manager,
			"Target",
			["src/target0.ts", "src/target1.ts", "src/target2.ts", "src/target3.ts"],
		));

		expect(hits).toHaveLength(2);
		expect(hits.every((hit) => hit.origin === "workspace-symbol")).toBe(true);
	});

	it("workspace symbol 保留 exact qualified symbol", async () => {
		await writeConfig({ servers: { fake: testServer("unused-lsp", ["ts"]) } });
		mockReady();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([{
			name: "parse",
			containerName: "Parser",
			kind: 6,
			location: { uri: pathToFileURL(path.join(workspace, "src", "parser.ts")).toString(), range: range(0) },
		}]);

		const hits = await withManager((manager) => queryWorkspaceSymbols(manager, "Parser.parse", ["src/parser.ts"]));

		expect(hits).toEqual([expect.objectContaining({ symbol: "parse", qualified_symbol: "Parser.parse", exact: true })]);
	});

	it("专用 server 覆盖 fallback，workspace symbol 只接收归属路径", async () => {
		await writeConfig({
			servers: {
				compose: { command: ["unused-compose"], languages: { dockercompose: "compose.yaml" } },
				yaml: { fallback: true, command: ["unused-yaml"], languages: { yaml: "*.{yaml,yml}" } },
			},
		});
		const composeUri = pathToUri(path.join(workspace, "deploy", "compose.yaml"));
		const yamlUri = pathToUri(path.join(workspace, "deploy", "service.yaml"));
		const requests: string[] = [];
		mockReady();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockImplementation(async function (this: LspClient) {
			requests.push(this.server.id);
			return this.server.id === "compose"
				? [
					{ name: "ComposeTarget", kind: 12, location: { uri: composeUri, range: range(0) } },
					{ name: "WrongService", kind: 12, location: { uri: yamlUri, range: range(0) } },
				]
				: [
					{ name: "DuplicateCompose", kind: 12, location: { uri: composeUri, range: range(0) } },
					{ name: "YamlTarget", kind: 12, location: { uri: yamlUri, range: range(0) } },
				];
		});

		const hits = await withManager((manager) =>
			queryWorkspaceSymbols(manager, "Target", ["deploy/compose.yaml", "deploy/service.yaml"]));

		expect(requests).toEqual(["compose", "yaml"]);
		expect(hits.map((hit) => `${hit.symbol}:${hit.path}`)).toEqual([
			"ComposeTarget:deploy/compose.yaml",
			"YamlTarget:deploy/service.yaml",
		]);
	});

	it("歧义路由不启动 server 并暴露到 status", async () => {
		await writeConfig({
			servers: {
				one: { command: ["unused-one"], languages: { one: "*.ts" } },
				two: { command: ["unused-two"], languages: { two: "*.ts" } },
			},
		});
		const ensureReady = mockReady();

		await withManager(async (manager) => {
			await expect(queryWorkspaceSymbols(manager, "target", ["src/target.ts"])).resolves.toEqual([]);
			await expect(manager.status(workspace)).resolves.toMatchObject({
				last_error: expect.stringContaining("matches multiple"),
				servers: [],
			});
		});
		expect(ensureReady).not.toHaveBeenCalled();
	});

	it("scope 前置过滤、resolve 成功且不请求预算外候选", async () => {
		await writeConfig({
			enabled: true,
			grep: { workspace_symbols: true, max_symbols: 2 },
			servers: { fake: testServer("unused", ["ts"]) },
		});
		const uri = (name: string) => pathToUri(path.join(workspace, "src", name));
		mockReady();
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([
			{ name: "outside", kind: 12, location: { uri: pathToUri(path.join(workspace, "outside.ts")) } },
			{ name: "fail", kind: 12, location: { uri: uri("fail.ts") } },
			{ name: "good", kind: 12, location: { uri: uri("good.ts") }, data: { id: 1 } },
			{ name: "complete", kind: 12, location: { uri: uri("complete.ts"), range: range(3) } },
			{ name: "extra", kind: 12, location: { uri: uri("extra.ts") }, data: { id: 2 } },
		]);
		const resolved: string[] = [];
		vi.spyOn(LspClient.prototype, "resolveWorkspaceSymbol").mockImplementation(async (symbol) => {
			resolved.push(symbol.name);
			return { ...symbol, location: { uri: uri(`${symbol.name}.ts`), range: range(2) } };
		});

		const hits = await withManager((manager) => queryWorkspaceSymbols(
			manager,
			"target",
			["src/fail.ts", "src/good.ts", "src/complete.ts", "src/extra.ts"],
		));
		expect(hits.map((hit) => hit.path)).toEqual(["src/fail.ts", "src/good.ts"]);
		expect(resolved).toEqual(["fail", "good"]);
	});

	it("多 server 查询并行，但按 registry 与 server 原始顺序稳定合并", async () => {
		await writeConfig({
			enabled: true,
			grep: { workspace_symbols: true, max_symbols: 4 },
			servers: {
				ts: testServer("unused-ts", ["ts"]),
				py: testServer("unused-py", ["py"]),
			},
		});
		mockReady();
		let releaseTs: () => void = () => undefined;
		const tsGate = new Promise<void>((resolve) => {
			releaseTs = resolve;
		});
		let markPythonStarted: () => void = () => undefined;
		const pythonStarted = new Promise<void>((resolve) => {
			markPythonStarted = resolve;
		});
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockImplementation(async function (this: LspClient) {
			if (this.server.id === "ts") {
				await tsGate;
				return [{ name: "tsFirst", kind: 12, location: { uri: pathToUri(path.join(workspace, "src", "a.ts")), range: range(0) } }];
			}
			markPythonStarted();
			return [{ name: "pySecond", kind: 12, location: { uri: pathToUri(path.join(workspace, "src", "b.py")), range: range(0) } }];
		});

		const hits = await withManager(async (manager) => {
			const pending = queryWorkspaceSymbols(manager, "target", ["src/a.ts", "src/b.py"]);
			await pythonStarted;
			releaseTs();
			return pending;
		});
		expect(hits.map((hit) => hit.symbol)).toEqual(["tsFirst", "pySecond"]);
	});

	it.skipIf(process.platform === "win32")("reload 等待顽固 language server 退出并在超时后强杀", async () => {
		const pidPath = path.join(configDir, "stubborn-lsp.pid");
		const server = path.join(configDir, "stubborn-lsp.mjs");
		await writeFile(server, [
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
			'process.on("SIGTERM", () => {});',
			fakeServerSource(workspace),
		].join("\n"));
		await writeConfig({
			enabled: true,
			startup_timeout_ms: 2000,
			request_timeout_ms: 2000,
			servers: { stubborn: testServer([process.execPath, server], ["ts"]) },
		});

		const pid = await withManager(async (manager) => {
			await queryWorkspaceSymbols(manager, "target", undefined, false);
			return Number(await readFile(pidPath, "utf8"));
		});

		expect(Number.isInteger(pid)).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});

async function writeConfig(config: unknown): Promise<void> {
	const configPath = path.join(configDir, "lsp.jsonc");
	await writeFile(configPath, JSON.stringify(config));
	process.env.PI_LSP_CONFIG = configPath;
}

function mockReady() {
	const ensureReady = vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
	vi.spyOn(LspClient.prototype, "capabilities").mockReturnValue(fullCapabilities);
	vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue(defaultDocumentSymbols());
	vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue([]);
	vi.spyOn(LspClient.prototype, "references").mockResolvedValue([]);
	return ensureReady;
}

async function withManager<T>(run: (manager: LspManager) => Promise<T>): Promise<T> {
	const manager = new LspManager();
	try { return await run(manager); } finally { await manager.reload(); }
}

async function queryWorkspaceSymbols(
	manager: LspManager,
	query: string,
	paths: readonly string[] = ["src/def.ts", "src/use.ts", "src/target.ts"],
	loadDocuments = true,
) {
	const analysis = await manager.codeAnalysis({
		root: workspace,
		query,
		targets: paths.map((targetPath) => ({ path: targetPath, ranges: [] })),
		allowRelated: true,
		limit: 8,
		async load(relativePath) {
			if (!loadDocuments) return undefined;
			return {
				path: relativePath,
				text: `${"x".repeat(64)}\n`,
				hash: `hash:${relativePath}`,
				filePath: path.join(workspace, relativePath),
			};
		},
	});
	if (analysis === undefined) return [];
	return analysis.files.flatMap(({ document: value, analysis: file }) => file.units.map((unit) => ({
		path: value.path,
		start_line: unit.startLine,
		end_line: unit.endLine,
		kind: unit.kind,
		symbol: unit.name,
		...(unit.qualifiedName === undefined ? {} : { qualified_symbol: unit.qualifiedName }),
		exact: unit.name === query || unit.qualifiedName === query,
		origin: "workspace-symbol" as const,
	})));
}

function defaultDocumentSymbols(): SymbolInformation[] {
	return documentSymbolNames.map((name) => {
		const range = { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } };
		return {
			name,
			kind: 12,
			location: { uri: pathToUri(path.join(workspace, "analysis.ts")), range },
			...(name === "parse" ? { containerName: "Parser" } : {}),
		};
	});
}

function testServer(command: string | readonly string[], extensions: readonly string[], enabled = true) {
	const selectors = extensions.map((extension) => `*.${extension}`);
	return {
		...(enabled ? {} : { enabled: false }),
		command: typeof command === "string" ? [command] : [...command],
		languages: { test: selectors.length === 1 ? selectors[0] : selectors },
	};
}

function range(line: number) {
	return { start: { line, character: 0 }, end: { line, character: 6 } };
}

function fakeServerSource(root: string): string {
	const defUri = pathToUri(path.join(root, "src", "def.ts"));
	return `
let buffer = Buffer.alloc(0);
setInterval(() => {}, 60_000);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const marker = buffer.indexOf("\\r\\n\\r\\n");
		if (marker === -1) return;
		const header = buffer.slice(0, marker).toString("utf8");
		const match = header.match(/Content-Length: (\\d+)/i);
		if (match === null) throw new Error("missing content-length");
		const length = Number(match[1]);
		const start = marker + 4;
		if (buffer.length < start + length) return;
		const message = JSON.parse(buffer.slice(start, start + length).toString("utf8"));
		buffer = buffer.slice(start + length);
		handle(message);
	}
});

function handle(message) {
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
		return;
	}
	if (message.method === "workspace/symbol") {
		send({ jsonrpc: "2.0", id: message.id, result: [{
			name: "target",
			kind: 12,
			location: { uri: ${JSON.stringify(defUri)}, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } }
		}] });
		return;
	}
	if (message.method === "shutdown") {
		send({ jsonrpc: "2.0", id: message.id, result: null });
	}
}

function send(message) {
	const body = JSON.stringify(message);
	process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}
`;
}

function pathToUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).toString();
}
