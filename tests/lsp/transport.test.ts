import net, { type Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationType } from "vscode-jsonrpc/node";

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
	connections: number;
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
let directClients: LspClient[] = [];
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
	await Promise.allSettled(directClients.map((client) => client.shutdown()));
	directClients = [];
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
		await expect(queryManagerSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([
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
		await expect(queryManagerSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([
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
		await expect(queryManagerSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([]);
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
		await expect(queryManagerSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({
			servers: [{ id: "tcp", status: "unavailable", last_error: expect.stringContaining("initialize failed") }],
		});
	});

	it("TCP session 保存 capabilities、取消请求并安全处理 server request", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true, textDocumentSync: { openClose: true, change: 1 } } } });
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
			language_ids: {},
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

	it("同文档并发同步保序、内容未变复用 documentSymbol cache", async () => {
		let documentSymbolRequests = 0;
		let markFirstRequest: () => void = () => undefined;
		const firstRequest = new Promise<void>((resolve) => {
			markFirstRequest = resolve;
		});
		let releaseFirstRequest: () => void = () => undefined;
		const firstRequestGate = new Promise<void>((resolve) => {
			releaseFirstRequest = resolve;
		});
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					documentSymbolProvider: true,
					textDocumentSync: { openClose: true, change: 1, save: true },
				} } });
			} else if (message.method === "textDocument/documentSymbol") {
				documentSymbolRequests += 1;
				const response = () => send(socket, { id: message.id, result: [documentSymbol("target", documentSymbolRequests)] });
				if (documentSymbolRequests === 1) {
					markFirstRequest();
					void firstRequestGate.then(response);
				} else {
					response();
				}
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const client = directClient(fake);
		expect(await client.ensureReady()).toBe(true);
		const file = path.join(workspace, "a.ts");
		const first = client.documentSymbols(file, "const target = 1;\n");
		const second = client.documentSymbols(file, "const target = 2;\n");
		await firstRequest;
		expect(fake.methods).not.toContain("textDocument/didChange");
		releaseFirstRequest();
		const [firstSymbols, secondSymbols] = await Promise.all([first, second]);
		expect(firstSymbols?.[0]?.name).toBe("target");
		expect(secondSymbols?.[0]?.name).toBe("target");

		const beforeWarmRead = fake.methods.length;
		await expect(client.documentSymbols(file, "const target = 2;\n")).resolves.toEqual(secondSymbols);
		expect(fake.methods).toHaveLength(beforeWarmRead);
		await expect(client.didSave(file, "const target = 2;\n")).resolves.toBe(true);
		await client.shutdown();

		const documentMethods = fake.methods.filter((method) => method.startsWith("textDocument/"));
		expect(documentMethods).toEqual([
			"textDocument/didOpen",
			"textDocument/documentSymbol",
			"textDocument/didChange",
			"textDocument/documentSymbol",
			"textDocument/didSave",
			"textDocument/didClose",
		]);
		expect(fake.messages.find((message) => message.method === "textDocument/didChange")).toMatchObject({
			params: {
				textDocument: { version: 2 },
				contentChanges: [{ text: "const target = 2;\n" }],
			},
		});
		const saveParams = fake.messages.find((message) => message.method === "textDocument/didSave")?.params;
		expect(saveParams).not.toHaveProperty("text");
	});

	it("incremental sync 使用 UTF-16 range，language_ids 与 save includeText 生效", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
				} } });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const client = directClient(fake);
		expect(await client.ensureReady()).toBe(true);
		const file = path.join(workspace, "a.tsx");
		const previous = "const 😀x = 1;\r\n";
		const next = "const 😀x = 2;\r\n";
		await expect(client.didOpenOrChange(file, previous)).resolves.toBe(true);
		await expect(client.didOpenOrChange(file, next)).resolves.toBe(true);
		await expect(client.didSave(file, next)).resolves.toBe(true);
		await client.shutdown();

		expect(fake.messages.find((message) => message.method === "textDocument/didOpen")).toMatchObject({
			params: { textDocument: { languageId: "typescriptreact", version: 1, text: previous } },
		});
		expect(fake.messages.find((message) => message.method === "textDocument/didChange")).toMatchObject({
			params: {
				textDocument: { version: 2 },
				contentChanges: [{
					range: { start: { line: 0, character: 12 }, end: { line: 0, character: 13 } },
					text: "2",
				}],
			},
		});
		expect(fake.messages.find((message) => message.method === "textDocument/didSave")).toMatchObject({
			params: { text: next },
		});
	});

	it("textDocumentSync None 不发送 open/change/save/close", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					textDocumentSync: { openClose: false, change: 0, save: false },
				} } });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const client = directClient(fake);
		expect(await client.ensureReady()).toBe(true);
		const file = path.join(workspace, "a.ts");
		await expect(client.didOpenOrChange(file, "one\n")).resolves.toBe(true);
		await expect(client.didOpenOrChange(file, "two\n")).resolves.toBe(true);
		await expect(client.didSave(file, "two\n")).resolves.toBe(true);
		await expect(client.didClose(file)).resolves.toBe(true);
		await client.shutdown();
		expect(fake.methods.filter((method) => method.startsWith("textDocument/"))).toEqual([]);
	});

	it("document LRU 淘汰前 didClose，并清除旧 symbol cache", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					documentSymbolProvider: true,
					textDocumentSync: { openClose: true, change: 1 },
				} } });
			} else if (message.method === "textDocument/documentSymbol") {
				send(socket, { id: message.id, result: [documentSymbol("target", 0)] });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const client = directClient(fake, 1);
		expect(await client.ensureReady()).toBe(true);
		const first = path.join(workspace, "a.ts");
		const second = path.join(workspace, "b.ts");
		await client.documentSymbols(first, "const a = 1;\n");
		await client.documentSymbols(second, "const b = 1;\n");
		await client.documentSymbols(first, "const a = 1;\n");

		expect(fake.methods.filter((method) => method.startsWith("textDocument/"))).toEqual([
			"textDocument/didOpen",
			"textDocument/documentSymbol",
			"textDocument/didClose",
			"textDocument/didOpen",
			"textDocument/documentSymbol",
			"textDocument/didClose",
			"textDocument/didOpen",
			"textDocument/documentSymbol",
		]);
		expect(client.status().open_documents).toBe(1);
	});

	it("publishDiagnostics 丢弃旧文档版本，未打开或无 version 时仍接受", async () => {
		const uri = pathToFileUri(path.join(workspace, "a.ts"));
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { textDocumentSync: { openClose: true, change: 1 } } } });
				send(socket, { method: "textDocument/publishDiagnostics", params: {
					uri,
					version: 5,
					diagnostics: [diagnostic("workspace", 0)],
				} });
			} else if (message.method === "textDocument/didOpen") {
				send(socket, { method: "textDocument/publishDiagnostics", params: {
					uri,
					version: 0,
					diagnostics: [diagnostic("stale", 0)],
				} });
				send(socket, { method: "textDocument/publishDiagnostics", params: {
					uri,
					version: 1,
					diagnostics: [diagnostic("current", 0)],
				} });
				send(socket, { method: "textDocument/publishDiagnostics", params: {
					uri,
					diagnostics: [diagnostic("unversioned", 0)],
				} });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const client = directClient(fake);
		const received: Array<number | undefined> = [];
		client.onDiagnostics((params) => received.push(params.version));
		expect(await client.ensureReady()).toBe(true);
		await expect(client.didOpenOrChange(path.join(workspace, "a.ts"), "const a = 1;\n")).resolves.toBe(true);
		await client.shutdown();
		expect(received).toEqual([5, 1, undefined]);
	});

	it("didWrite 只接受 captured revision 之后的 diagnostics，旧快照不能伪装成功", async () => {
		const uri = pathToFileUri(path.join(workspace, "a.ts"));
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					textDocumentSync: { openClose: true, change: 1, save: true },
				} } });
			} else if (message.method === "textDocument/didOpen") {
				send(socket, { method: "textDocument/publishDiagnostics", params: {
					uri,
					version: 1,
					diagnostics: [diagnostic("new error", 1)],
				} });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		await writeConfig(
			{ type: "tcp", host: "127.0.0.1", port: fake.port },
			{ diagnostics: { enabled: true, max_wait_ms: 100, settle_ms: 0, max_items: 8, min_severity: "warning" } },
		);
		manager = new LspManager();
		const file = path.join(workspace, "a.ts");
		await expect(manager.didWrite(workspace, file, "const a = 1;\n")).resolves.toMatchObject({
			status: "errors",
			items: [{ message: "new error" }],
		});
		await expect(manager.beforeDiagnostics(workspace, file)).resolves.toMatchObject({ known: true, version: 1 });
		await expect(manager.didWrite(workspace, file, "const a = 2;\n")).resolves.toMatchObject({
			status: "timeout",
			total_items: 0,
		});
	});

	it("capability 不支持时不发送不适用的 feature request", async () => {
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {} } });
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port });

		manager = new LspManager();
		await expect(queryManagerSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([]);
		expect(fake.methods).not.toContain("workspace/symbol");
	});

	it("grep 取消贯穿 workspace request 并发送 $/cancelRequest", async () => {
		let markRequested: () => void = () => undefined;
		const requested = new Promise<void>((resolve) => {
			markRequested = resolve;
		});
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
			} else if (message.method === "workspace/symbol") {
				markRequested();
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port }, { request_timeout_ms: 1000 });
		manager = new LspManager();
		const controller = new AbortController();
		const pending = manager.workspaceSymbols({
			root: workspace,
			query: "target",
			extensions: [".ts"],
			allowedPaths: new Set(["src/target.ts"]),
			signal: controller.signal,
		});
		await requested;
		controller.abort();
		await expect(pending).resolves.toEqual([]);
		await fake.cancelled;
	});

	it("并发 ensureReady 共享一次启动，TCP initialize 使用 null processId", async () => {
		let releaseInitialize: () => void = () => undefined;
		let markInitialize: () => void = () => undefined;
		const initializeSeen = new Promise<void>((resolve) => { markInitialize = resolve; });
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				markInitialize();
				releaseInitialize = () => send(socket, { id: message.id, result: { capabilities: {} } });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const client = directClient(fake);
		const starts = Array.from({ length: 8 }, () => client.ensureReady());
		await initializeSeen;
		expect(fake.connections).toBe(1);
		expect(fake.methods.filter((method) => method === "initialize")).toHaveLength(1);
		releaseInitialize();
		await expect(Promise.all(starts)).resolves.toEqual(Array.from({ length: 8 }, () => true));
		expect(fake.messages.find((message) => message.method === "initialize")).toMatchObject({
			params: { processId: null },
		});
	});

	it("idle timer 不会中断活动请求", async () => {
		let releaseRequest: () => void = () => undefined;
		let markRequest: () => void = () => undefined;
		const requestSeen = new Promise<void>((resolve) => { markRequest = resolve; });
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
			} else if (message.method === "workspace/symbol") {
				markRequest();
				releaseRequest = () => send(socket, { id: message.id, result: [] });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		const client = directClient(fake, 64, 10);
		expect(await client.ensureReady()).toBe(true);
		vi.useFakeTimers();
		try {
			expect(await client.ensureReady()).toBe(true);
			const pending = client.workspaceSymbols("target");
			await vi.advanceTimersByTimeAsync(0);
			await requestSeen;
			await vi.advanceTimersByTimeAsync(20);
			expect(client.status().status).toBe("ready");
			expect(fake.methods).not.toContain("shutdown");
			releaseRequest();
			vi.useRealTimers();
			await expect(pending).resolves.toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reload 等待活动请求，并阻止新操作进入旧 client", async () => {
		let symbolRequests = 0;
		let releaseFirst: () => void = () => undefined;
		let markFirst: () => void = () => undefined;
		const firstSeen = new Promise<void>((resolve) => { markFirst = resolve; });
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
			} else if (message.method === "workspace/symbol") {
				symbolRequests += 1;
				if (symbolRequests === 1) {
					markFirst();
					releaseFirst = () => send(socket, { id: message.id, result: [] });
				} else {
					send(socket, { id: message.id, result: [] });
				}
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port });
		manager = new LspManager();
		const first = queryManagerSymbols(manager, workspace, "first", [".ts"]);
		await firstSeen;
		const reloading = manager.reload();
		const second = queryManagerSymbols(manager, workspace, "second", [".ts"]);
		expect(fake.methods).not.toContain("shutdown");
		releaseFirst();
		await expect(first).resolves.toEqual([]);
		await reloading;
		await expect(second).resolves.toEqual([]);
		expect(fake.connections).toBe(2);
		expect(fake.methods.filter((method) => method === "initialize")).toHaveLength(2);
	});

	it("crash cleanup 后使用全新连接重启，达到上限不保留旧资源", async () => {
		let symbolRequests = 0;
		const uri = pathToFileUri(path.join(workspace, "src", "target.ts"));
		const fake = await createFakeServer((message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true } } });
			} else if (message.method === "workspace/symbol") {
				symbolRequests += 1;
				if (symbolRequests !== 2) socket.destroy();
				else send(socket, { id: message.id, result: [{ name: "target", kind: 12, location: {
					uri,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
				} }] });
			} else if (message.method === "shutdown") {
				send(socket, { id: message.id, result: null });
			} else if (message.method === "exit") {
				socket.end();
			}
		});
		await writeConfig({ type: "tcp", host: "127.0.0.1", port: fake.port }, { max_restarts: 1 });
		manager = new LspManager();
		await expect(queryManagerSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({
			servers: [{ status: "crashed", open_documents: 0 }],
		});
		await expect(queryManagerSymbols(manager, workspace, "target", [".ts"])).resolves.toEqual([
			expect.objectContaining({ path: "src/target.ts", symbol: "target" }),
		]);
		await expect(queryManagerSymbols(manager, workspace, "crash-again", [".ts"])).resolves.toEqual([]);
		await expect(queryManagerSymbols(manager, workspace, "restart-limit", [".ts"])).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({ servers: [{ status: "crashed" }] });
		expect(fake.connections).toBe(2);
	});

	it("stdio drain 大量 stderr、保留有界尾部并使用 Pi PID", async () => {
		const client = stdioClient("stderr-crash");
		let resolveLog: (message: string) => void = () => undefined;
		const log = new Promise<string>((resolve) => { resolveLog = resolve; });
		client.onLogMessage((params) => resolveLog(params.message));
		expect(await client.ensureReady()).toBe(true);
		await expect(log).resolves.toContain(`parent:${process.pid}`);
		await expect(client.workspaceSymbols("crash")).resolves.toBeUndefined();
		await client.waitForCleanup();
		expect(client.status()).toMatchObject({
			status: "crashed",
			open_documents: 0,
			last_error: expect.stringContaining("STDERR_TAIL_MARKER"),
		});
	});

	it("notification backpressure 超时后进入 crash cleanup", async () => {
		const client = stdioClient("notification-timeout");
		let markLog: () => void = () => undefined;
		const log = new Promise<void>((resolve) => { markLog = resolve; });
		client.onLogMessage(() => markLog());
		expect(await client.ensureReady()).toBe(true);
		await log;
		await expect(client.notification(new NotificationType<string>("test/backpressure"), "x".repeat(16 * 1024 * 1024))).resolves.toBe(false);
		expect(client.status()).toMatchObject({ status: "crashed", open_documents: 0 });
	});

	it("stdio 顽固 child 在 shutdown 后被强制终止", async () => {
		const client = stdioClient("stubborn");
		let resolveLog: (message: string) => void = () => undefined;
		const log = new Promise<string>((resolve) => { resolveLog = resolve; });
		client.onLogMessage((params) => resolveLog(params.message));
		expect(await client.ensureReady()).toBe(true);
		const message = await log;
		const match = /pid:(\d+)/.exec(message);
		expect(match).not.toBeNull();
		const pid = Number(match?.[1]);
		await client.shutdown();
		expect(() => process.kill(pid, 0)).toThrow();
	});
});

function directClient(fake: FakeServer, maxOpenDocuments = 64, idleTimeoutMs?: number): LspClient {
	const config = defaultLspConfig();
	config.startup_timeout_ms = 500;
	config.request_timeout_ms = 500;
	config.max_open_documents = maxOpenDocuments;
	if (idleTimeoutMs !== undefined) config.idle_timeout_ms = idleTimeoutMs;
	const client = new LspClient(workspace, {
		id: "tcp",
		enabled: true,
		transport: { type: "tcp", host: "127.0.0.1", port: fake.port },
		language_ids: {
			".ts": "typescript",
			".tsx": "typescriptreact",
			".js": "javascript",
			".jsx": "javascriptreact",
		},
		extensions: [".ts", ".tsx", ".js", ".jsx"],
	}, config, new DiagnosticsLedger(), () => undefined, () => 0);
	directClients.push(client);
	return client;
}

function stdioClient(mode: "notification-timeout" | "stderr-crash" | "stubborn"): LspClient {
	const config = defaultLspConfig();
	config.startup_timeout_ms = 3000;
	config.request_timeout_ms = mode === "notification-timeout" ? 50 : 500;
	config.idle_timeout_ms = 0;
	const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
	const client = new LspClient(workspace, {
		id: "stdio",
		enabled: true,
		transport: { type: "stdio", command: process.execPath, args: [fixture, mode] },
		language_ids: { ".ts": "typescript" },
		extensions: [".ts"],
	}, config, new DiagnosticsLedger(), () => undefined, () => 0);
	directClients.push(client);
	return client;
}

function documentSymbol(name: string, line: number): Record<string, unknown> {
	const range = { start: { line, character: 0 }, end: { line, character: name.length } };
	return { name, kind: 12, range, selectionRange: range };
}

function diagnostic(message: string, line: number): Record<string, unknown> {
	return {
		severity: 1,
		range: { start: { line, character: 0 }, end: { line, character: 1 } },
		message,
		source: "fake",
	};
}

function queryManagerSymbols(manager: LspManager, root: string, query: string, extensions: readonly string[]) {
	return manager.workspaceSymbols({
		root,
		query,
		extensions,
		allowedPaths: new Set(["src/target.ts", "src/def.ts", "src/use.ts", "a.ts"]),
	});
}

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
		get connections() {
			return connections;
		},
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
