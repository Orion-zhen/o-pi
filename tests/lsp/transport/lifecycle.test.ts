import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { LspClient } from "../../../src/lsp/client/client.js";
import { LspManager } from "../../../src/lsp/manager/manager.js";
import { pathToFileUri } from "../../../src/lsp/protocol/uri.js";
import { createManager, createFakeServer, createWorkspaceSymbolServer, deferred, directClient, queryManagerSymbols, send, useTransportFixture, writeConfig } from "./fixtures.js";

const transport = useTransportFixture();

describe("lsp transport lifecycle", () => {
	it.each([
		["workspace request", false],
		["workspaceSymbol/resolve", true],
	] as const)("grep 取消正在进行的 %s 并发送 $/cancelRequest", async (_name, resolveSymbol) => {
		const workspace = transport.workspace;
		const uri = pathToFileUri(path.join(workspace, "src", "target.ts"));
		const requestStarted = deferred<void>();
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, {
					id: message.id,
					result: { capabilities: {
						workspaceSymbolProvider: resolveSymbol ? { resolveProvider: true } : true,
						documentSymbolProvider: true,
						referencesProvider: true,
						callHierarchyProvider: true,
					} },
				});
			} else if (message.method === "workspace/symbol") {
				if (resolveSymbol) {
					send(socket, { id: message.id, result: [{ name: "target", kind: 12, location: { uri }, data: { id: 1 } }] });
				} else {
					requestStarted.resolve();
				}
			} else if (message.method === "workspaceSymbol/resolve") {
				requestStarted.resolve();
			}
		});
		await writeConfig(transport, { type: "tcp", host: "127.0.0.1", port: fake.port }, { request_timeout_ms: 1000 });
		const manager = transport.manager = new LspManager();
		const controller = new AbortController();
		const pending = queryManagerSymbols(manager, workspace, "target", controller.signal);
		await requestStarted.promise;
		controller.abort();
		await expect(pending).resolves.toEqual([]);
		await fake.cancelled;
	});
	it("调用方取消后不等待共享 initialize 完成", async () => {
		const workspace = transport.workspace;
		const initializeSeen = deferred<void>();
		let releaseInitialize: () => void = () => undefined;
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				initializeSeen.resolve();
				releaseInitialize = () => send(socket, {
					id: message.id,
					result: { capabilities: { workspaceSymbolProvider: true, documentSymbolProvider: true, referencesProvider: true, callHierarchyProvider: true } },
				});
			}
		});
		const manager = await createManager(transport, fake, { startup_timeout_ms: 1000, request_timeout_ms: 1000 });
		const controller = new AbortController();
		const pending = queryManagerSymbols(manager, workspace, "target", controller.signal);
		await initializeSeen.promise;

		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		controller.abort();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settledAfterCancellation = settled;

		releaseInitialize();
		await expect(pending).resolves.toEqual([]);
		expect(settledAfterCancellation).toBe(true);
	});
	it("并发 ensureReady 共享一次启动，TCP initialize 使用 null processId", async () => {
		let releaseInitialize: () => void = () => undefined;
		const initializeSeen = deferred<void>();
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				initializeSeen.resolve();
				releaseInitialize = () => send(socket, { id: message.id, result: { capabilities: {} } });
			}
		});
		const client = directClient(transport, fake);
		const starts = Array.from({ length: 8 }, () => client.ensureReady());
		await initializeSeen.promise;
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
		const requestSeen = deferred<void>();
		const fake = await createWorkspaceSymbolServer(transport, (message, socket) => {
				requestSeen.resolve();
				releaseRequest = () => send(socket, { id: message.id, result: [] });
		});
		const client = directClient(transport, fake, 64, 10);
		expect(await client.ensureReady()).toBe(true);
		vi.useFakeTimers();
		try {
			expect(await client.ensureReady()).toBe(true);
			const pending = client.workspaceSymbols("target");
			await vi.advanceTimersByTimeAsync(0);
			await requestSeen.promise;
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
		const workspace = transport.workspace;
		let symbolRequests = 0;
		let releaseFirst: () => void = () => undefined;
		const firstSeen = deferred<void>();
		const fake = await createWorkspaceSymbolServer(transport, (message, socket) => {
				symbolRequests += 1;
				if (symbolRequests === 1) {
					firstSeen.resolve();
					releaseFirst = () => send(socket, { id: message.id, result: [] });
				} else {
					send(socket, { id: message.id, result: [] });
				}
		});
		const manager = await createManager(transport, fake);
		const first = queryManagerSymbols(manager, workspace, "first");
		await firstSeen.promise;
		const reloading = manager.reload();
		const second = queryManagerSymbols(manager, workspace, "second");
		expect(fake.methods).not.toContain("shutdown");
		releaseFirst();
		await expect(first).resolves.toEqual([]);
		await reloading;
		await expect(second).resolves.toEqual([]);
		expect(fake.connections).toBe(2);
		expect(fake.methods.filter((method) => method === "initialize")).toHaveLength(2);
	});
	it("operation 与连续 reload 同 tick 时先登记活动操作", async () => {
		const workspace = transport.workspace;
		let symbolRequests = 0;
		let releaseRaced: () => void = () => undefined;
		const racedSeen = deferred<void>();
		const fake = await createWorkspaceSymbolServer(transport, (message, socket) => {
				symbolRequests += 1;
				if (symbolRequests === 2) {
					racedSeen.resolve();
					releaseRaced = () => send(socket, { id: message.id, result: [] });
				} else {
					send(socket, { id: message.id, result: [] });
				}
		});
		const manager = await createManager(transport, fake);
		await expect(queryManagerSymbols(manager, workspace, "warmup")).resolves.toEqual([]);

		const raced = queryManagerSymbols(manager, workspace, "raced");
		const firstReload = manager.reload();
		const secondReload = manager.reload();
		await racedSeen.promise;
		expect(fake.methods).not.toContain("shutdown");
		releaseRaced();
		await expect(raced).resolves.toEqual([]);
		await Promise.all([firstReload, secondReload]);
		expect(fake.methods.filter((method) => method === "shutdown")).toHaveLength(1);

		await expect(queryManagerSymbols(manager, workspace, "fresh")).resolves.toEqual([]);
		expect(fake.connections).toBe(2);
	});
	it("活动操作失败后释放 reload drain", async () => {
		const workspace = transport.workspace;
		const fake = await createWorkspaceSymbolServer(transport, (message, socket) => {
				send(socket, { id: message.id, result: [] });
		});
		const manager = await createManager(transport, fake);
		await expect(queryManagerSymbols(manager, workspace, "warmup")).resolves.toEqual([]);
		const request = vi.spyOn(LspClient.prototype, "workspaceSymbols").mockRejectedValueOnce(new Error("injected failure"));
		try {
			const failed = queryManagerSymbols(manager, workspace, "failed");
			const failure = expect(failed).rejects.toThrow("injected failure");
			const reloading = manager.reload();
			await failure;
			await reloading;
			expect(fake.methods).toContain("shutdown");
		} finally {
			request.mockRestore();
		}
	});
	it("活动操作取消后释放 reload drain", async () => {
		const workspace = transport.workspace;
		let symbolRequests = 0;
		const pendingSeen = deferred<void>();
		const fake = await createWorkspaceSymbolServer(transport, (message, socket) => {
				symbolRequests += 1;
				if (symbolRequests === 1) send(socket, { id: message.id, result: [] });
				else pendingSeen.resolve();
		});
		const manager = await createManager(transport, fake);
		await expect(queryManagerSymbols(manager, workspace, "warmup")).resolves.toEqual([]);
		const controller = new AbortController();
		const pending = queryManagerSymbols(manager, workspace, "cancelled", controller.signal);
		await pendingSeen.promise;
		const reloading = manager.reload();
		expect(fake.methods).not.toContain("shutdown");
		controller.abort();

		await expect(pending).resolves.toEqual([]);
		await reloading;
		expect(fake.methods).toContain("$/cancelRequest");
		expect(fake.methods).toContain("shutdown");
	});
	it("crash 后保持 crashed，后续增强降级，reload 后按需创建新连接", async () => {
		const workspace = transport.workspace;
		let symbolRequests = 0;
		const uri = pathToFileUri(path.join(workspace, "src", "target.ts"));
		const fake = await createWorkspaceSymbolServer(transport, (message, socket) => {
				symbolRequests += 1;
				if (symbolRequests === 1) socket.destroy();
				else send(socket, { id: message.id, result: [{ name: "target", kind: 12, location: {
					uri,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
				} }] });
		});
		const manager = await createManager(transport, fake);

		await expect(queryManagerSymbols(manager, workspace, "target")).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({
			servers: [{ status: "crashed", open_documents: 0, last_error: expect.any(String) }],
		});
		await expect(queryManagerSymbols(manager, workspace, "after-crash")).resolves.toEqual([]);
		expect(fake.connections).toBe(1);

		await manager.reload();
		await expect(queryManagerSymbols(manager, workspace, "target")).resolves.toEqual([
			expect.objectContaining({ path: "src/target.ts", symbol: "target" }),
		]);
		expect(fake.connections).toBe(2);
		await expect(manager.status(workspace)).resolves.toMatchObject({ servers: [{ status: "ready" }] });
	});
});
