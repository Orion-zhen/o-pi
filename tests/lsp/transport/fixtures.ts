import net, { type Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";

import { LspClient } from "../../../src/lsp/client/client.js";
import { defaultLspConfig } from "../../../src/lsp/config/loader.js";
import { DiagnosticsLedger } from "../../../src/lsp/diagnostics/ledger.js";
import { LspManager } from "../../../src/lsp/manager/manager.js";
import { deferred } from "../../helpers/async.js";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.js";

export interface JsonRpcMessage {
	method?: string;
	id?: number;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

export type MessageHandler = (message: JsonRpcMessage, socket: Socket) => void;

interface ProtocolServerOptions {
	readonly capabilities?: Record<string, unknown>;
	readonly routes?: Readonly<Record<string, MessageHandler>>;
	readonly afterInitialize?: MessageHandler;
	readonly onInitialized?: MessageHandler;
	readonly onMessage?: MessageHandler;
}

export interface FakeServer {
	readonly port: number;
	readonly connections: number;
	readonly methods: string[];
	readonly messages: JsonRpcMessage[];
	readonly response: Promise<JsonRpcMessage>;
	readonly cancelled: Promise<void>;
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

export interface TransportFixture {
	workspace: string;
	configDir: string;
	manager: LspManager | undefined;
	directClients: LspClient[];
	fakeServers: FakeServer[];
}

export function useTransportFixture(): TransportFixture {
	const workspaceTemp = useTempDir("o-pi-lsp-transport-workspace-");
	const configTemp = useTempDir("o-pi-lsp-transport-config-");
	const fixture: TransportFixture = {
		workspace: "",
		configDir: "",
		manager: undefined,
		directClients: [],
		fakeServers: [],
	};
	preserveEnv("PI_LSP_CONFIG");

	beforeEach(() => {
		fixture.workspace = workspaceTemp.path;
		fixture.configDir = configTemp.path;
	});

	afterEach(async () => {
		await fixture.manager?.reload();
		fixture.manager = undefined;
		await Promise.allSettled(fixture.directClients.map((client) => client.shutdown()));
		fixture.directClients = [];
		await Promise.all(fixture.fakeServers.map((fake) => fake.close()));
		fixture.fakeServers = [];
	});

	return fixture;
}

export function directClient(
	fixture: TransportFixture,
	fake: FakeServer,
	maxOpenDocuments = 64,
	idleTimeoutMs?: number,
	diagnostics = new DiagnosticsLedger(),
): LspClient {
	const config = defaultLspConfig();
	config.startup_timeout_ms = 500;
	config.request_timeout_ms = 500;
	config.max_open_documents = maxOpenDocuments;
	if (idleTimeoutMs !== undefined) config.idle_timeout_ms = idleTimeoutMs;
	const client = new LspClient(fixture.workspace, {
		id: "tcp",
		enabled: true,
		transport: { type: "tcp", host: "127.0.0.1", port: fake.port },
		fallback: false,
		routes: [
			{ languageId: "typescript", selectors: ["*.ts"] },
			{ languageId: "typescriptreact", selectors: ["*.tsx"] },
			{ languageId: "javascript", selectors: ["*.js"] },
			{ languageId: "javascriptreact", selectors: ["*.jsx"] },
		],
	}, config, diagnostics, () => undefined);
	fixture.directClients.push(client);
	return client;
}

export function stdioClient(fixture: TransportFixture, mode: "notification-timeout" | "stderr-crash" | "stubborn"): LspClient {
	const config = defaultLspConfig();
	config.startup_timeout_ms = 3000;
	config.request_timeout_ms = mode === "notification-timeout" ? 50 : 500;
	config.idle_timeout_ms = 0;
	const fixturePath = fileURLToPath(new URL("../fixtures/stdio-server.mjs", import.meta.url));
	const metadataPath = path.join(fixture.configDir, `stdio-${mode}.meta`);
	const client = new LspClient(fixture.workspace, {
		id: "stdio",
		enabled: true,
		transport: { type: "stdio", command: process.execPath, args: [fixturePath, mode, metadataPath] },
		fallback: false,
		routes: [{ languageId: "typescript", selectors: ["*.ts"] }],
	}, config, new DiagnosticsLedger(), () => undefined);
	fixture.directClients.push(client);
	return client;
}

export function documentSymbol(name: string, line: number): Record<string, unknown> {
	const range = { start: { line, character: 0 }, end: { line, character: name.length } };
	return { name, kind: 12, range, selectionRange: range };
}

export function diagnostic(message: string, line: number): Record<string, unknown> {
	return {
		severity: 1,
		range: { start: { line, character: 0 }, end: { line, character: 1 } },
		message,
		source: "fake",
	};
}

export async function queryManagerSymbols(manager: LspManager, root: string, query: string, signal?: AbortSignal) {
	vi.spyOn(LspClient.prototype, "documentSymbols").mockResolvedValue([{
		name: "target",
		kind: 12,
		range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
		selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
	}]);
	vi.spyOn(LspClient.prototype, "incomingCalls").mockResolvedValue([]);
	vi.spyOn(LspClient.prototype, "references").mockResolvedValue([]);
	const analysis = await manager.codeAnalysis({
		root,
		query,
		targets: ["src/target.ts", "src/def.ts", "src/use.ts", "a.ts"].map((targetPath) => ({ path: targetPath, ranges: [] })),
		allowRelated: true,
		limit: 8,
		...(signal === undefined ? {} : { signal }),
		async load(relativePath) {
			return {
				path: relativePath,
				text: "\n\n      target\n",
				hash: `hash:${relativePath}`,
				filePath: path.join(root, relativePath),
			};
		},
	});
	return analysis?.files.flatMap(({ document, analysis: file }) => file.index.units.map((unit) => ({
		path: document.path,
		start_line: unit.startLine,
		end_line: unit.endLine,
		kind: unit.kind,
		symbol: unit.name ?? "",
		origin: "workspace-symbol" as const,
	}))) ?? [];
}

export async function createManager(
	fixture: TransportFixture,
	fake: FakeServer,
	overrides: Record<string, unknown> = {},
): Promise<LspManager> {
	await writeConfig(fixture, { type: "tcp", host: "127.0.0.1", port: fake.port }, overrides);
	const manager = new LspManager();
	fixture.manager = manager;
	return manager;
}

export async function writeConfig(
	fixture: TransportFixture,
	transport: { type: "tcp"; host: string; port: number },
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const file = path.join(fixture.configDir, "lsp.jsonc");
	await writeFile(file, JSON.stringify({
		enabled: true,
		startup_timeout_ms: 500,
		request_timeout_ms: 500,
		...overrides,
		servers: {
			tcp: {
				tcp: { host: transport.host, port: transport.port },
				languages: { typescript: "*.ts" },
			},
		},
	}));
	process.env.PI_LSP_CONFIG = file;
}

export function createProtocolServer(
	fixture: TransportFixture,
	options: ProtocolServerOptions,
): Promise<FakeServer> {
	return createFakeServer(fixture, (message, socket) => {
		if (message.method === "initialize") {
			send(socket, { id: message.id, result: { capabilities: options.capabilities ?? {} } });
			options.afterInitialize?.(message, socket);
			return;
		}
		if (message.method === "initialized") options.onInitialized?.(message, socket);
		if (message.method !== undefined) options.routes?.[message.method]?.(message, socket);
		options.onMessage?.(message, socket);
	});
}

export function createWorkspaceSymbolServer(
	fixture: TransportFixture,
	handler: MessageHandler,
): Promise<FakeServer> {
	return createProtocolServer(fixture, {
		capabilities: {
			workspaceSymbolProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			callHierarchyProvider: true,
		},
		routes: { "workspace/symbol": handler },
	});
}

export async function createFakeServer(fixture: TransportFixture, handler: MessageHandler): Promise<FakeServer> {
	const methods: string[] = [];
	const messages: JsonRpcMessage[] = [];
	const sockets = new Set<Socket>();
	const response = deferred<JsonRpcMessage>();
	const cancelled = deferred<void>();
	const closed = deferred<void>();
	let serverClosed = false;
	let connections = 0;
	const server = net.createServer((socket) => {
		connections += 1;
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
					if (message.method === "$/cancelRequest") cancelled.resolve();
				} else if (message.id !== undefined) {
					response.resolve(message);
				}
				if (message.method === "shutdown") {
					send(socket, { id: message.id, result: null });
				} else if (message.method === "exit") {
					socket.end();
				} else {
					handler(message, socket);
				}
			}
		});
		socket.once("close", () => {
			sockets.delete(socket);
			if (sockets.size === 0) closed.resolve();
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
		get connections() {
			return connections;
		},
		methods,
		messages,
		response: response.promise,
		cancelled: cancelled.promise,
		closed: closed.promise,
		close: async () => {
			if (serverClosed) return;
			serverClosed = true;
			for (const socket of sockets) socket.destroy();
			if (!server.listening) return;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
	fixture.fakeServers.push(fake);
	return fake;
}

export function send(socket: Socket, message: Record<string, unknown>): void {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	socket.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
