import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LspClient } from "../../src/lsp/client.js";
import { LspManager } from "../../src/lsp/manager.js";
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

describe("lsp workspace symbols", () => {
	it("root 命中 exclude_paths 时不启动 LSP", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(
			config,
			JSON.stringify({
				enabled: true,
				exclude_paths: [workspace],
				servers: { fake: testServer("missing-lsp", ["ts"]) },
			}),
		);
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await expect(queryWorkspaceSymbols(manager, workspace, "target")).resolves.toEqual([]);
		await expect(manager.didWrite(workspace, path.join(workspace, "a.ts"), "const x = 1;\n")).resolves.toBeUndefined();
		await expect(manager.status(workspace)).resolves.toMatchObject({ enabled: false, servers: [] });
		await manager.reload();
	});

	it("server binary 缺失时退化为 unavailable", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(
			config,
			JSON.stringify({
				enabled: true,
				startup_timeout_ms: 200,
				servers: { missing: testServer("definitely-missing-o-pi-lsp", ["ts"]) },
			}),
		);
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await expect(queryWorkspaceSymbols(manager, workspace, "target")).resolves.toEqual([]);
		const status = await manager.status(workspace);
		expect(status.servers[0]).toMatchObject({ id: "missing", status: "unavailable" });
		expect(status.servers[0]?.last_error).toMatch(/failed to start|ENOENT/);
		await manager.reload();
	});

	it("workspace symbols 按 scope 文件 selector 路由且空 scope 不启动 server", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			servers: {
				ts: testServer("unused-ts", ["ts"]),
				python: testServer("unused-python", ["py"]),
				disabled: testServer("unused-go", ["go"], false),
			},
		}));
		process.env.PI_LSP_CONFIG = config;
		const requests: string[] = [];
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockImplementation(async function (this: LspClient) {
			requests.push(this.server.id);
			return [];
		});

		const manager = new LspManager();
		await expect(queryWorkspaceSymbols(manager, workspace, "target", ["src/target.ts"])).resolves.toEqual([]);
		await expect(queryWorkspaceSymbols(manager, workspace, "target", ["src/target.ts", "src/target.py"])).resolves.toEqual([]);
		await expect(queryWorkspaceSymbols(manager, workspace, "target", [])).resolves.toEqual([]);
		await expect(queryWorkspaceSymbols(manager, workspace, "target", ["src/target.go"])).resolves.toEqual([]);
		await manager.reload();

		expect(requests).toEqual(["ts", "ts", "python"]);
	});

	it("outline 关闭且不需要 enclosing symbol 时不启动 client", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			read: { outline: false, max_symbols: 40 },
			servers: { fake: testServer("unused", ["ts"]) },
		}));
		process.env.PI_LSP_CONFIG = config;
		const ensureReady = vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		const documentSymbols = vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([]);

		const manager = new LspManager();
		const result = await manager.readEnhancement(
			workspace,
			path.join(workspace, "a.ts"),
			"const value = 1;\n",
			{ startLine: 1, endLine: 1 },
			{ outline: true, enclosing: false },
		);
		await manager.reload();

		expect(result).toBeUndefined();
		expect(ensureReady).not.toHaveBeenCalled();
		expect(documentSymbols).not.toHaveBeenCalled();
	});

	it("workspace symbol 按配置限制同名 exact leaf", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			grep: { workspace_symbols: true, max_symbols: 10, max_exact_leaf_symbols: 2 },
			servers: { fake: testServer("unused-lsp", ["ts"]) },
		}));
		process.env.PI_LSP_CONFIG = config;
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([
			0, 1, 2, 3,
		].map((index) => ({
			name: "Target",
			kind: 12,
			location: { uri: pathToUri(path.join(workspace, "src", `target${index}.ts`)), range: range(index) },
		})));

		const manager = new LspManager();
		const hits = await manager.workspaceSymbols({
			root: workspace,
			query: "Target",
			allowedPaths: new Set(["src/target0.ts", "src/target1.ts", "src/target2.ts", "src/target3.ts"]),
		});
		await manager.reload();

		expect(hits).toHaveLength(2);
		expect(hits.every((hit) => hit.origin === "workspace-symbol")).toBe(true);
	});

	it("workspace symbol 保留 exact qualified symbol", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({ servers: { fake: testServer("unused-lsp", ["ts"]) } }));
		process.env.PI_LSP_CONFIG = config;
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([{
			name: "parse",
			containerName: "Parser",
			kind: 6,
			location: { uri: pathToFileURL(path.join(workspace, "src", "parser.ts")).toString(), range: range(0) },
		}]);

		const manager = new LspManager();
		const hits = await manager.workspaceSymbols({
			root: workspace,
			query: "Parser.parse",
			allowedPaths: new Set(["src/parser.ts"]),
		});
		await manager.reload();

		expect(hits).toEqual([expect.objectContaining({ symbol: "parse", qualified_symbol: "Parser.parse", exact: true })]);
	});

	it("专用 server 覆盖 fallback，workspace symbol 只接收归属路径", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			servers: {
				compose: { command: ["unused-compose"], languages: { dockercompose: "compose.yaml" } },
				yaml: { fallback: true, command: ["unused-yaml"], languages: { yaml: "*.{yaml,yml}" } },
			},
		}));
		process.env.PI_LSP_CONFIG = config;
		const composeUri = pathToUri(path.join(workspace, "deploy", "compose.yaml"));
		const yamlUri = pathToUri(path.join(workspace, "deploy", "service.yaml"));
		const requests: string[] = [];
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
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

		const manager = new LspManager();
		const hits = await manager.workspaceSymbols({
			root: workspace,
			query: "Target",
			allowedPaths: new Set(["deploy/compose.yaml", "deploy/service.yaml"]),
		});
		await manager.reload();

		expect(requests).toEqual(["compose", "yaml"]);
		expect(hits.map((hit) => `${hit.symbol}:${hit.path}`)).toEqual([
			"ComposeTarget:deploy/compose.yaml",
			"YamlTarget:deploy/service.yaml",
		]);
	});

	it("歧义路由不启动 server 并暴露到 status", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			servers: {
				one: { command: ["unused-one"], languages: { one: "*.ts" } },
				two: { command: ["unused-two"], languages: { two: "*.ts" } },
			},
		}));
		process.env.PI_LSP_CONFIG = config;
		const ensureReady = vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		const manager = new LspManager();

		await expect(manager.workspaceSymbols({
			root: workspace,
			query: "target",
			allowedPaths: new Set(["src/target.ts"]),
		})).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({
			last_error: expect.stringContaining("matches multiple"),
			servers: [],
		});
		expect(ensureReady).not.toHaveBeenCalled();
		await manager.reload();
	});

	it("scope 前置过滤、resolve 失败补位且不请求预算外候选", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			grep: { workspace_symbols: true, max_symbols: 2 },
			servers: { fake: testServer("unused", ["ts"]) },
		}));
		process.env.PI_LSP_CONFIG = config;
		const uri = (name: string) => pathToUri(path.join(workspace, "src", name));
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
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
			return symbol.name === "good" ? { ...symbol, location: { uri: uri("good.ts"), range: range(2) } } : undefined;
		});

		const manager = new LspManager();
		const hits = await manager.workspaceSymbols({
			root: workspace,
			query: "target",
			allowedPaths: new Set(["src/fail.ts", "src/good.ts", "src/complete.ts", "src/extra.ts"]),
		});
		await manager.reload();
		expect(hits.map((hit) => hit.path)).toEqual(["src/good.ts", "src/complete.ts"]);
		expect(resolved).toEqual(["fail", "good"]);
	});

	it("多 server 查询并行，但按 registry 与 server 原始顺序稳定合并", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			grep: { workspace_symbols: true, max_symbols: 4 },
			servers: {
				ts: testServer("unused-ts", ["ts"]),
				py: testServer("unused-py", ["py"]),
			},
		}));
		process.env.PI_LSP_CONFIG = config;
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
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

		const manager = new LspManager();
		const pending = manager.workspaceSymbols({
			root: workspace,
			query: "target",
			allowedPaths: new Set(["src/a.ts", "src/b.py"]),
		});
		await pythonStarted;
		releaseTs();
		const hits = await pending;
		await manager.reload();
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
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			startup_timeout_ms: 2000,
			request_timeout_ms: 2000,
			servers: { stubborn: testServer([process.execPath, server], ["ts"]) },
		}));
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await queryWorkspaceSymbols(manager, workspace, "target");
		const pid = Number(await readFile(pidPath, "utf8"));
		await manager.reload();

		expect(Number.isInteger(pid)).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});

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

function queryWorkspaceSymbols(
	manager: LspManager,
	root: string,
	query: string,
	paths: readonly string[] = ["src/def.ts", "src/use.ts", "src/target.ts"],
) {
	return manager.workspaceSymbols({ root, query, allowedPaths: new Set(paths) });
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
