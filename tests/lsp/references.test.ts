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
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([]);
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
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([]);
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
		await expect(manager.workspaceSymbols(workspace, "target", [".TS"])).resolves.toEqual([]);
		await expect(manager.workspaceSymbols(workspace, "target", [".ts", ".py"])).resolves.toEqual([]);
		await expect(manager.workspaceSymbols(workspace, "target", [])).resolves.toEqual([]);
		await expect(manager.workspaceSymbols(workspace, "target", [".go"])).resolves.toEqual([]);
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
		const hits = await grepSymbols({ workspaceRoot: workspace, query: "target", path: ".", extensions: [".ts"] });
		await manager.reload();

		expect(hits).toEqual([
			expect.objectContaining({ path: "src/def.ts", reason: "lsp exact symbol", origin: "workspace-symbol" }),
			expect.objectContaining({ path: "src/use.ts", reason: "lsp reference", origin: "reference" }),
		]);
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
		await manager.workspaceSymbols(workspace, "target", [".ts"]);
		const pid = Number(await readFile(pidPath, "utf8"));
		await manager.reload();

		expect(Number.isInteger(pid)).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});

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
