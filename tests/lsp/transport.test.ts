import net, { type Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LspClient } from "../../src/lsp/client.js";
import { defaultLspConfig } from "../../src/lsp/config.js";
import { DiagnosticsLedger } from "../../src/lsp/diagnostics.js";
import { LspManager } from "../../src/lsp/manager.js";
import { pathToFileUri } from "../../src/lsp/uri.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

interface JsonRpcMessage {
	method?: string;
	id?: number;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

type MessageHandler = (message: JsonRpcMessage, socket: Socket) => void;

interface FakeServer {
	port: number;
	methods: string[];
	messages: JsonRpcMessage[];
	response: Promise<JsonRpcMessage>;
	cancelled: Promise<void>;
	closed: Promise<void>;
	close(): Promise<void>;
}

let workspace: string;
let configDir: string;
let manager: LspManager | undefined;
let fakeServers: FakeServer[] = [];
const workspaceTemp = useTempDir("o-pi-lsp-transport-workspace-");
const configTemp = useTempDir("o-pi-lsp-transport-config-");
preserveEnv("PI_LSP_CONFIG");

beforeEach(() => {
	workspace = workspaceTemp.path;
	configDir = configTemp.path;
});

afterEach(async () => {
	await manager?.reload();
	manager = undefined;
	await Promise.all(fakeServers.map((fake) => fake.close()));
	fakeServers = [];
});

describe("lsp transport", () => {
	it("TCP server 支持 initialize、workspace symbol 和 reload 清理连接", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
			} else if (message.method === "workspace/symbol") {
				send(socket, {
					id: message.id,
					result: [{
						name: "target",
						kind: 12,
						location: {
							uri: pathToFileUri(path.join(workspace, "src", "target.ts")),
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
						},
					}],
				});
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port });

		manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([
			expect.objectContaining({ path: "src/target.ts", origin: "workspace-symbol" }),
		]);
		const firstReload = manager.reload();
		const secondReload = manager.reload();
		await Promise.all([firstReload, secondReload]);
		await fake.closed;
		expect(fake.methods).toContain("initialize");
		expect(fake.methods).toContain("workspace/symbol");
		expect(fake.methods).not.toContain("workspaceSymbol/resolve");
		expect(fake.messages.find((message) => message.method === "initialize")).toMatchObject({
			params: {
				capabilities: {
					workspace: { symbol: { resolveSupport: { properties: ["location.range"] } } },
				},
			},
		});
		expect(fake.methods.filter((method) => method === "shutdown")).toHaveLength(1);
		expect(fake.methods).toContain("exit");
	});

	it("URI-only workspace symbol 原样 resolve 并转换为 hit", async () => {
		const uri = pathToFileUri(path.join(workspace, "src", "target.ts"));
		const data = { serverKey: "target-1", nested: { revision: 3 } };
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: { resolveProvider: true } } } });
			} else if (message.method === "workspace/symbol") {
				send(socket, { id: message.id, result: [{ name: "target", kind: 12, location: { uri }, data }] });
			} else if (message.method === "workspaceSymbol/resolve") {
				send(socket, {
					id: message.id,
					result: {
						name: "target",
						kind: 12,
						location: { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } },
						data,
					},
				});
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port });

		manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([
			expect.objectContaining({ path: "src/target.ts", start_line: 3, end_line: 3, origin: "workspace-symbol" }),
		]);
		expect(fake.messages.find((message) => message.method === "workspaceSymbol/resolve")).toMatchObject({
			params: { name: "target", kind: 12, location: { uri }, data },
		});
	});

	it.each([
		["server 未声明 resolveProvider", "unsupported", false],
		["resolve 返回错误", "error", true],
		["resolve 超时", "timeout", true],
		["resolve 后仍无 range", "unresolved", true],
	] as const)("%s 时安全跳过 URI-only symbol", async (_name, mode, expectsResolve) => {
		const uri = pathToFileUri(path.join(workspace, "src", "target.ts"));
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				const workspaceSymbolProvider = mode === "unsupported" ? true : { resolveProvider: true };
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider } } });
			} else if (message.method === "workspace/symbol") {
				send(socket, { id: message.id, result: [{ name: "target", kind: 12, location: { uri }, data: { key: 1 } }] });
			} else if (message.method === "workspaceSymbol/resolve") {
				if (mode === "error") send(socket, { id: message.id, error: { code: -32001, message: "resolve failed" } });
				if (mode === "unresolved") send(socket, { id: message.id, result: { name: "target", kind: 12, location: { uri } } });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		await writeConfig(
			{ type: "tcp", host: "127.0.0.1", port: fake.port },
			{ request_timeout_ms: 100 },
		);

		manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([]);
		if (expectsResolve) expect(fake.methods).toContain("workspaceSymbol/resolve");
		else expect(fake.methods).not.toContain("workspaceSymbol/resolve");
	});

	it("TCP initialize 失败时退化为 unavailable", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, error: { code: -32000, message: "initialize failed" } });
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port });

		manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({
			servers: [{ id: "tcp", status: "unavailable", last_error: expect.stringContaining("initialize failed") }],
		});
	});

	it("TCP session 保存 capabilities、取消请求并安全处理 server request", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
				send(socket, { method: "window/logMessage", params: { type: 3, message: "server log" } });
				send(socket, { method: "$/progress", params: { token: "work", value: { kind: "begin" } } });
				send(socket, { method: "textDocument/publishDiagnostics", params: { uri: pathToFileUri(path.join(workspace, "a.ts")), diagnostics: [] } });
				send(socket, { id: 77, method: "workspace/applyEdit", params: { edit: {} } });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const config = defaultLspConfig();
		config.startup_timeout_ms = 500;
		config.request_timeout_ms = 100;
		const client = new LspClient(workspace, {
			id: "tcp",
			enabled: true,
			transport: { type: "tcp", host: "127.0.0.1", port: fake.port },
			language_id: "typescript",
			extensions: [".ts"],
		}, config, new DiagnosticsLedger(), () => undefined, () => 0);
		const diagnostics: string[] = [];
		const logs: string[] = [];
		const progress: unknown[] = [];
		client.onDiagnostics((params) => diagnostics.push(params.uri));
		client.onLogMessage((params) => logs.push(params.message));
		client.onProgress((params) => progress.push(params.value));

		expect(await client.ensureReady()).toBe(true);
		expect(client.capabilities()?.workspaceSymbolProvider).toBe(true);
		await expect(client.workspaceSymbols("slow")).resolves.toBeUndefined();
		await fake.cancelled;
		await fake.response;
		await expect(client.didOpenOrChange(path.join(workspace, "a.ts"), "const a = 1;\n")).resolves.toBe(true);
		await expect(client.didClose(path.join(workspace, "a.ts"))).resolves.toBe(true);
		await client.shutdown();
		await fake.closed;

		expect(diagnostics).toEqual([pathToFileUri(path.join(workspace, "a.ts"))]);
		expect(logs).toEqual(["server log"]);
		expect(progress).toEqual([{ kind: "begin" }]);
		expect(fake.methods).toContain("textDocument/didOpen");
		expect(fake.methods).toContain("textDocument/didClose");
		await expect(fake.response).resolves.toMatchObject({ id: 77, error: { code: -32601 } });
	});

	it("capability 不支持时不发送不适用的 feature request", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {} } });
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port });

		manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([]);
		expect(fake.methods).not.toContain("workspace/symbol");
	});

	it("TCP 请求超时和断开时保持 file-tools 降级", async () => {
		let symbolRequests = 0;
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
			} else if (message.method === "workspace/symbol") {
				symbolRequests += 1;
				if (symbolRequests > 1) socket.destroy();
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port }, { request_timeout_ms: 100 });

		manager = new LspManager();
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([]);
		await expect(manager.workspaceSymbols(workspace, "target", [".ts"])).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({
			servers: [{ id: "tcp", status: "crashed" }],
		});
	});
});

async function writeConfig(transport: { type: "tcp"; host: string; port: number }, overrides: Record<string, unknown> = {}): Promise<void> {
	const file = path.join(configDir, "lsp.jsonc");
	await writeFile(file, JSON.stringify({
		enabled: true,
		startup_timeout_ms: 500,
		request_timeout_ms: 500,
		...overrides,
		servers: [{ id: "tcp", transport, extensions: [".ts"] }],
	}));
	process.env.PI_LSP_CONFIG = file;
}

async function createFakeServer(handler: MessageHandler): Promise<FakeServer> {
	const methods: string[] = [];
	const messages: JsonRpcMessage[] = [];
	const sockets = new Set<Socket>();
	let resolveResponse: (message: JsonRpcMessage) => void = () => undefined;
	const response = new Promise<JsonRpcMessage>((resolve) => {
		resolveResponse = resolve;
	});
	let resolveCancelled: () => void = () => undefined;
	const cancelled = new Promise<void>((resolve) => {
		resolveCancelled = resolve;
	});
	let resolveClosed: () => void = () => undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	let serverClosed = false;
	const server = net.createServer((socket) => {
		sockets.add(socket);
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (true) {
				const marker = buffer.indexOf("\r\n\r\n");
				if (marker < 0) return;
				const header = buffer.subarray(0, marker).toString("utf8");
				const match = header.match(/Content-Length:\s*(\d+)/i);
				if (match === null) throw new Error("missing content length");
				const length = Number(match[1]);
				const start = marker + 4;
				if (buffer.length < start + length) return;
				const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8")) as JsonRpcMessage;
				buffer = buffer.subarray(start + length);
				messages.push(message);
				if (message.method !== undefined) {
					methods.push(message.method);
					if (message.method === "$/cancelRequest") resolveCancelled();
				} else if (message.id !== undefined) {
					resolveResponse(message);
				}
				handler(message, socket);
			}
		});
		socket.once("close", () => {
			sockets.delete(socket);
			if (sockets.size === 0) resolveClosed();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fake server did not bind a TCP port");
	const fake: FakeServer = {
		port: address.port,
		methods,
		messages,
		response,
		cancelled,
		closed,
		close: async () => {
			if (serverClosed) return;
			serverClosed = true;
			for (const socket of sockets) socket.destroy();
			if (!server.listening) return;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
	fakeServers.push(fake);
	return fake;
}

function send(socket: Socket, message: Record<string, unknown>): void {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	socket.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
