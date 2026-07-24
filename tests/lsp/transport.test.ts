import net, { type Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LspManager } from "../../src/lsp/manager.js";
import { pathToFileUri } from "../../src/lsp/uri.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

interface JsonRpcMessage {
	method?: string;
	id?: number;
	params?: unknown;
}

type MessageHandler = (message: JsonRpcMessage, socket: Socket) => void;

interface FakeServer {
	port: number;
	methods: string[];
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
		await manager.reload();
		await fake.closed;
		expect(fake.methods).toContain("initialize");
		expect(fake.methods).toContain("workspace/symbol");
		expect(fake.methods).toContain("shutdown");
		expect(fake.methods).toContain("exit");
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

	it("TCP 请求超时和断开时保持 file-tools 降级", async () => {
		let symbolRequests = 0;
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {} } });
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

async function createFakeServer(handler: MessageHandler): Promise<{ port: number; methods: string[]; closed: Promise<void>; close: () => Promise<void> }> {
	const methods: string[] = [];
	const sockets = new Set<Socket>();
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
				if (message.method !== undefined) methods.push(message.method);
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
