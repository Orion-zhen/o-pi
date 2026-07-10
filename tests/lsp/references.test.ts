import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

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

describe("lsp references", () => {
	it("root 命中 exclude_paths 时不启动 LSP", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(
			config,
			JSON.stringify({
				version: 1,
				enabled: true,
				exclude_paths: [workspace],
				servers: [{ id: "fake", command: "missing-lsp", extensions: [".ts"] }],
			}),
		);
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target")).resolves.toEqual([]);
		await expect(manager.didWrite(workspace, path.join(workspace, "a.ts"), "const x = 1;\n")).resolves.toBeUndefined();
		await expect(manager.status(workspace)).resolves.toMatchObject({ enabled: false, servers: [] });
		await manager.reload();
	});

	it("server binary 缺失时退化为 unavailable", async () => {
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(
			config,
			JSON.stringify({
				version: 1,
				enabled: true,
				startup_timeout_ms: 200,
				servers: [{ id: "missing", command: "definitely-missing-o-pi-lsp", extensions: [".ts"] }],
			}),
		);
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target")).resolves.toEqual([]);
		const status = await manager.status(workspace);
		expect(status.servers[0]).toMatchObject({ id: "missing", status: "unavailable" });
		expect(status.servers[0]?.last_error).toMatch(/failed to start|ENOENT/);
		await manager.reload();
	});

	it("grep references 开启时把 textDocument/references 转为 symbol 候选", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "def.ts"), "export function target() {}\n");
		await writeFile(path.join(workspace, "src", "use.ts"), "target();\n");
		const server = path.join(configDir, "fake-lsp.mjs");
		await writeFile(server, fakeServerSource(workspace));
		const config = path.join(configDir, "lsp.jsonc");
		await writeFile(
			config,
			JSON.stringify({
				version: 1,
				enabled: true,
				startup_timeout_ms: 2000,
				request_timeout_ms: 2000,
				grep: { workspace_symbols: true, references: true, max_symbols: 4, max_references: 4 },
				servers: [{ id: "fake", command: process.execPath, args: [server], extensions: [".ts"] }],
			}),
		);
		process.env.PI_LSP_CONFIG = config;

		const manager = new LspManager();
		const hits = await manager.workspaceSymbols(workspace, "target");
		await manager.reload();

		expect(hits).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "src/def.ts", symbol: "target", exact: true }),
			expect.objectContaining({ path: "src/use.ts", symbol: "target", exact: false }),
		]));
	});
});

function fakeServerSource(root: string): string {
	const defUri = pathToUri(path.join(root, "src", "def.ts"));
	const useUri = pathToUri(path.join(root, "src", "use.ts"));
	return `
let buffer = Buffer.alloc(0);
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
