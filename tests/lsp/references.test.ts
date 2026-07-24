import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LspClient } from "../../src/lsp/client.js";
import { createLspFileHooks } from "../../src/lsp/file-hooks.js";
import { LspManager } from "../../src/lsp/manager.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let configDir: string;
const workspaceTemp = useTempDir("o-pi-lsp-ref-workspace-");
const configTemp = useTempDir("o-pi-lsp-ref-config-");
preserveEnv("PI_LSP_CONFIG");

beforeEach(() => {
	workspace = workspaceTemp.path;
	configDir = configTemp.path;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("lsp references", () => {
	it("root 命中 exclude_paths 时不启动 LSP", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(
			config,
			JSON.stringify({
				enabled: true,
				exclude_paths: [workspace],
				servers: [{ id: "fake", command: "missing-lsp", extensions: [".ts"] }],
			}),
		);
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await expect(queryWorkspaceSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([]);
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
				servers: [{ id: "missing", command: "definitely-missing-o-pi-lsp", extensions: [".ts"] }],
			}),
		);
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await expect(queryWorkspaceSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([]);
		const status = await manager.status(workspace);
		expect(status.servers[0]).toMatchObject({ id: "missing", status: "unavailable" });
		expect(status.servers[0]?.last_error).toMatch(/failed to start|ENOENT/);
		await manager.reload();
	});

	it("workspace symbols 按 scope 扩展名路由且空 scope 不启动 server", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			servers: [
				{ id: "ts", command: "unused-ts", extensions: [".ts"] },
				{ id: "python", command: "unused-python", extensions: [".py"] },
				{ id: "disabled", enabled: false, command: "unused-go", extensions: [".go"] },
			],
		}));
		process.env.PI_LSP_CONFIG = config;
		const requests: string[] = [];
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockImplementation(async function (this: LspClient) {
			requests.push(this.server.id);
			return [];
		});

		const manager = new LspManager();
		await expect(queryWorkspaceSymbols(manager, workspace, "target", [".TS"])).resolves.toEqual([]);
		await expect(queryWorkspaceSymbols(manager, workspace, "target", [".ts", ".py"])).resolves.toEqual([]);
		await expect(queryWorkspaceSymbols(manager, workspace, "target", [])).resolves.toEqual([]);
		await expect(queryWorkspaceSymbols(manager, workspace, "target", [".go"])).resolves.toEqual([]);
		await manager.reload();

		expect(requests).toEqual(["ts", "ts", "python"]);
	});

	it("grep references 经 workspaceSymbols 与 file hook 保留 symbol 和 reference 来源", async () => {
		const definitionUri = pathToUri(path.join(workspace, "src", "def.ts"));
		const referenceUri = pathToUri(path.join(workspace, "src", "use.ts"));
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			grep: { workspace_symbols: true, references: true, max_symbols: 4, max_references: 4 },
			servers: [{ id: "fake", command: "unused-lsp", extensions: [".ts"] }],
		}));
		process.env.PI_LSP_CONFIG = config;
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([{
			name: "target",
			kind: 12,
			location: {
				uri: definitionUri,
				range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
			},
		}]);
		vi.spyOn(LspClient.prototype, "references").mockResolvedValue([{
			uri: referenceUri,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
		}]);

		const manager = new LspManager();
		const grepSymbols = createLspFileHooks(manager).grepSymbols;
		if (grepSymbols === undefined) throw new Error("grepSymbols hook missing");
		const hits = await grepSymbols({
			workspaceRoot: workspace,
			query: "target",
			path: ".",
			extensions: [".ts"],
			allowedPaths: new Set(["src/def.ts", "src/use.ts"]),
		});
		await manager.reload();

		expect(hits).toEqual([
			expect.objectContaining({ path: "src/def.ts", reason: "lsp exact symbol", origin: "workspace-symbol" }),
			expect.objectContaining({ path: "src/use.ts", reason: "lsp reference", origin: "reference" }),
		]);
	});

	it("scope 前置过滤、resolve 失败补位且不请求预算外候选", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			grep: { workspace_symbols: true, references: false, max_symbols: 2, max_references: 0 },
			servers: [{ id: "fake", command: "unused", extensions: [".ts"] }],
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
			extensions: [".ts"],
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
			grep: { workspace_symbols: true, references: false, max_symbols: 4, max_references: 0 },
			servers: [
				{ id: "ts", command: "unused-ts", extensions: [".ts"] },
				{ id: "py", command: "unused-py", extensions: [".py"] },
			],
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
			extensions: [".ts", ".py"],
			allowedPaths: new Set(["src/a.ts", "src/b.py"]),
		});
		await pythonStarted;
		releaseTs();
		const hits = await pending;
		await manager.reload();
		expect(hits.map((hit) => hit.symbol)).toEqual(["tsFirst", "pySecond"]);
	});

	it("symbol/reference 全局去重并在最终有效结果后计数", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			grep: { workspace_symbols: true, references: true, max_symbols: 1, max_references: 2 },
			servers: [{ id: "fake", command: "unused", extensions: [".ts"] }],
		}));
		process.env.PI_LSP_CONFIG = config;
		const definitionUri = pathToUri(path.join(workspace, "src", "def.ts"));
		const useUri = pathToUri(path.join(workspace, "src", "use.ts"));
		const symbol = { name: "target", kind: 12 as const, location: { uri: definitionUri, range: range(0) } };
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue([symbol, symbol]);
		const references = vi.spyOn(LspClient.prototype, "references").mockResolvedValue([
			{ uri: definitionUri, range: range(0) },
			{ uri: useUri, range: range(1) },
			{ uri: useUri, range: range(1) },
			{ uri: pathToUri(path.join(workspace, "outside.ts")), range: range(1) },
		]);

		const manager = new LspManager();
		const hits = await manager.workspaceSymbols({
			root: workspace,
			query: "target",
			extensions: [".ts"],
			allowedPaths: new Set(["src/def.ts", "src/use.ts"]),
		});
		await manager.reload();
		expect(hits.map((hit) => `${hit.origin}:${hit.path}`)).toEqual([
			"workspace-symbol:src/def.ts",
			"reference:src/use.ts",
		]);
		expect(references).toHaveBeenCalledTimes(1);
	});

	it("references 使用有界并发，剩余预算限制新请求数", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(config, JSON.stringify({
			enabled: true,
			grep: { workspace_symbols: true, references: true, max_symbols: 6, max_references: 4 },
			servers: [{ id: "fake", command: "unused", extensions: [".ts"] }],
		}));
		process.env.PI_LSP_CONFIG = config;
		vi.spyOn(LspClient.prototype, "ensureReady").mockResolvedValue(true);
		vi.spyOn(LspClient.prototype, "workspaceSymbols").mockResolvedValue(Array.from({ length: 6 }, (_, index) => ({
			name: `target${index}`,
			kind: 12,
			location: { uri: pathToUri(path.join(workspace, "src", `def${index}.ts`)), range: range(index) },
		})));
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let markFirstBatch: () => void = () => undefined;
		const firstBatch = new Promise<void>((resolve) => {
			markFirstBatch = resolve;
		});
		let releaseFirstBatch: () => void = () => undefined;
		const firstBatchGate = new Promise<void>((resolve) => {
			releaseFirstBatch = resolve;
		});
		const references = vi.spyOn(LspClient.prototype, "references").mockImplementation(async (_uri, line) => {
			active += 1;
			started += 1;
			maxActive = Math.max(maxActive, active);
			if (started === 4) markFirstBatch();
			await firstBatchGate;
			active -= 1;
			return [{ uri: pathToUri(path.join(workspace, "src", `use${line}.ts`)), range: range(line) }];
		});

		const manager = new LspManager();
		const pending = manager.workspaceSymbols({
			root: workspace,
			query: "target",
			extensions: [".ts"],
			allowedPaths: new Set(Array.from({ length: 6 }, (_, index) => `src/def${index}.ts`).concat(
				Array.from({ length: 6 }, (_, index) => `src/use${index}.ts`),
			)),
		});
		await firstBatch;
		expect(maxActive).toBe(4);
		releaseFirstBatch();
		await pending;
		await manager.reload();
		expect(references).toHaveBeenCalledTimes(4);
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
			servers: [{ id: "stubborn", command: process.execPath, args: [server], extensions: [".ts"] }],
		}));
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await queryWorkspaceSymbols(manager, workspace, "target", [".ts"]);
		const pid = Number(await readFile(pidPath, "utf8"));
		await manager.reload();

		expect(Number.isInteger(pid)).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});

function range(line: number) {
	return { start: { line, character: 0 }, end: { line, character: 6 } };
}

function queryWorkspaceSymbols(manager: LspManager, root: string, query: string, extensions: readonly string[]) {
	return manager.workspaceSymbols({
		root,
		query,
		extensions,
		allowedPaths: new Set(["src/def.ts", "src/use.ts", "src/target.ts"]),
	});
}

function fakeServerSource(root: string): string {
	const defUri = pathToUri(path.join(root, "src", "def.ts"));
	const useUri = pathToUri(path.join(root, "src", "use.ts"));
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
		send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { workspaceSymbolProvider: true, referencesProvider: true } } });
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
	if (message.method === "textDocument/references") {
		send({ jsonrpc: "2.0", id: message.id, result: [
			{ uri: ${JSON.stringify(useUri)}, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }
		] });
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
	return new URL(`file://${path.resolve(filePath).replace(/\\/g, "/").startsWith("/") ? "" : "/"}${path.resolve(filePath).replace(/\\/g, "/")}`).toString();
}
