import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileChangeType } from "vscode-languageserver-protocol";

import { LspClient } from "../../../src/lsp/client/client.js";
import { defaultLspConfig } from "../../../src/lsp/config/loader.js";
import { DiagnosticsLedger } from "../../../src/lsp/diagnostics/ledger.js";
import { pathToFileUri } from "../../../src/lsp/protocol/uri.js";
import { createManager, createFakeServer, createWorkspaceSymbolServer, deferred, queryManagerSymbols, send, useTransportFixture } from "./fixtures.js";

const transport = useTransportFixture();

describe("lsp transport manager and protocol", () => {
	it("TCP server 支持 initialize、workspace symbol 和 reload 清理连接", async () => {
		const workspace = transport.workspace;
		const fake = await createWorkspaceSymbolServer(transport, (message, socket) => {
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
		});
		const manager = await createManager(transport, fake);
		await expect(queryManagerSymbols(manager, workspace, "target")).resolves.toEqual([
			expect.objectContaining({ path: "src/target.ts", origin: "workspace-symbol" }),
		]);
		const firstReload = manager.reload();
		const secondReload = manager.reload();
		await Promise.all([firstReload, secondReload]);
		await fake.closed;
		expect(fake.methods).toContain("initialize");
		expect(fake.methods).toContain("workspace/symbol");
		expect(fake.methods).not.toContain("workspaceSymbol/resolve");
		const initialize = fake.messages.find((message) => message.method === "initialize");
		expect(initialize).toMatchObject({
			params: {
				capabilities: {
					textDocument: {
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
						publishDiagnostics: { relatedInformation: true },
					},
					workspace: {
						configuration: true,
						workspaceFolders: true,
						didChangeConfiguration: { dynamicRegistration: true },
						didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
						symbol: { resolveSupport: { properties: ["location.range"] } },
					},
				},
			},
		});
		expect(initialize?.params).not.toHaveProperty("capabilities.window.workDoneProgress");
		expect(fake.methods.filter((method) => method === "shutdown")).toHaveLength(1);
		expect(fake.methods).toContain("exit");
	});
	it("安全响应基础 server requests，并按白名单 watcher 发送文件变更", async () => {
		const workspace = transport.workspace;
		const configDir = transport.configDir;
		const responseIds = new Set<number>();
		const responsesReceived = deferred<void>();
		const watchedNotificationReceived = deferred<void>();
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {} } });
			} else if (message.method === "initialized") {
				send(socket, { id: 81, method: "workspace/configuration", params: { items: [
					{ section: "typescript.preferences" },
					{ section: "missing" },
					{ scopeUri: pathToFileUri(path.join(configDir, "outside.ts")), section: "typescript" },
				] } });
				send(socket, { id: 82, method: "workspace/workspaceFolders", params: null });
				send(socket, { id: 83, method: "window/workDoneProgress/create", params: { token: "index" } });
				send(socket, { id: 84, method: "client/registerCapability", params: { registrations: [
					{
						id: "watch-config",
						method: "workspace/didChangeWatchedFiles",
						registerOptions: { watchers: [{
							globPattern: { baseUri: pathToFileUri(workspace), pattern: "**/{tsconfig.json,package.json}" },
							kind: 3,
						}] },
					},
					{ id: "config", method: "workspace/didChangeConfiguration", registerOptions: { section: "typescript" } },
				] } });
				send(socket, { id: 85, method: "client/registerCapability", params: { registrations: [
					{ id: "unsafe", method: "textDocument/hover" },
				] } });
				send(socket, { id: 86, method: "client/registerCapability", params: { registrations: [{
					id: "outside-watch",
					method: "workspace/didChangeWatchedFiles",
					registerOptions: { watchers: [{
						globPattern: { baseUri: pathToFileUri(configDir), pattern: "**/*.json" },
					}] },
				}] } });
			} else if (message.method === "workspace/didChangeWatchedFiles") {
				watchedNotificationReceived.resolve();
			} else if (message.method === undefined && message.id !== undefined && message.id >= 81 && message.id <= 86) {
				responseIds.add(message.id);
				if (responseIds.size === 6) responsesReceived.resolve();
			}
		});
		const config = defaultLspConfig();
		config.startup_timeout_ms = 500;
		config.request_timeout_ms = 500;
		const client = new LspClient(workspace, {
			id: "tcp",
			enabled: true,
			transport: { type: "tcp", host: "127.0.0.1", port: fake.port },
			fallback: false,
			routes: [{ languageId: "typescript", selectors: ["*.ts"] }],
			settings: { typescript: { preferences: { quoteStyle: "single" } } },
		}, config, new DiagnosticsLedger(), () => undefined);
		transport.directClients.push(client);

		expect(await client.ensureReady()).toBe(true);
		await responsesReceived.promise;
		const response = (id: number) => fake.messages.find((message) => message.method === undefined && message.id === id);
		expect(response(81)).toMatchObject({ result: [{ quoteStyle: "single" }, null, null] });
		expect(response(82)).toMatchObject({ result: [{ uri: pathToFileUri(workspace), name: path.basename(workspace) }] });
		expect(response(83)).toMatchObject({ error: { code: -32601 } });
		expect(response(84)).toMatchObject({ result: null });
		expect(response(85)).toMatchObject({ error: { code: -32602, message: expect.stringContaining("not allowed") } });
		expect(response(86)).toMatchObject({ error: { code: -32602, message: expect.stringContaining("inside the workspace") } });
		expect(fake.messages.find((message) => message.method === "workspace/didChangeConfiguration")).toMatchObject({
			params: { settings: { typescript: { preferences: { quoteStyle: "single" } } } },
		});

		expect(await client.didChangeWatchedFiles([
			{ filePath: path.join(workspace, "nested", "tsconfig.json"), type: FileChangeType.Changed },
			{ filePath: path.join(workspace, "package.json"), type: FileChangeType.Created },
			{ filePath: path.join(workspace, "pyproject.toml"), type: FileChangeType.Changed },
			{ filePath: path.join(configDir, "tsconfig.json"), type: FileChangeType.Changed },
		])).toBe(true);
		await watchedNotificationReceived.promise;
		expect(fake.messages.filter((message) => message.method === "workspace/didChangeWatchedFiles")).toMatchObject([
			{ params: { changes: [
				{ uri: pathToFileUri(path.join(workspace, "nested", "tsconfig.json")), type: FileChangeType.Changed },
				{ uri: pathToFileUri(path.join(workspace, "package.json")), type: FileChangeType.Created },
			] } },
		]);
	});
	it("manager 对未路由配置文件只通知已启动且已注册 watcher 的 server", async () => {
		const workspace = transport.workspace;
		const registered = deferred<void>();
		const watched = deferred<void>();
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true, documentSymbolProvider: true, referencesProvider: true, callHierarchyProvider: true } } });
			} else if (message.method === "initialized") {
				send(socket, { id: 90, method: "client/registerCapability", params: { registrations: [{
					id: "project-config",
					method: "workspace/didChangeWatchedFiles",
					registerOptions: { watchers: [{ globPattern: "**/tsconfig.json", kind: 2 }] },
				}] } });
			} else if (message.method === "workspace/symbol") {
				send(socket, { id: message.id, result: [] });
			} else if (message.method === "workspace/didChangeWatchedFiles") {
				watched.resolve();
			} else if (message.method === undefined && message.id === 90) {
				registered.resolve();
			}
		});
		const manager = await createManager(transport, fake);
		const configFile = path.join(workspace, "nested", "tsconfig.json");
		const secondConfigFile = path.join(workspace, "other", "tsconfig.json");

		await manager.didChangeWatchedFile(workspace, configFile, FileChangeType.Changed);
		expect(fake.connections).toBe(0);
		await queryManagerSymbols(manager, workspace, "start");
		await registered.promise;
		await manager.didChangeWatchedFiles([
			{ root: workspace, filePath: configFile, type: FileChangeType.Changed },
			{ root: workspace, filePath: secondConfigFile, type: FileChangeType.Changed },
		]);
		await watched.promise;

		expect(fake.messages.filter((message) => message.method === "workspace/didChangeWatchedFiles")).toMatchObject([{
			params: { changes: [
				{ uri: pathToFileUri(configFile), type: FileChangeType.Changed },
				{ uri: pathToFileUri(secondConfigFile), type: FileChangeType.Changed },
			] },
		}]);
	});
	it("URI-only workspace symbol 原样 resolve 并转换为 hit", async () => {
		const workspace = transport.workspace;
		const uri = pathToFileUri(path.join(workspace, "src", "target.ts"));
		const data = { serverKey: "target-1", nested: { revision: 3 } };
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: { resolveProvider: true }, documentSymbolProvider: true, referencesProvider: true, callHierarchyProvider: true } } });
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
			}
		});
		const manager = await createManager(transport, fake);
		await expect(queryManagerSymbols(manager, workspace, "target")).resolves.toEqual([
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
		["resolve 返回非法 range", "invalid", true],
	] as const)("%s 时安全跳过 URI-only symbol", async (_name, mode, expectsResolve) => {
		const workspace = transport.workspace;
		const uri = pathToFileUri(path.join(workspace, "src", "target.ts"));
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				const workspaceSymbolProvider = mode === "unsupported" ? true : { resolveProvider: true };
				send(socket, { id: message.id, result: { capabilities: {
					workspaceSymbolProvider,
					documentSymbolProvider: true,
					referencesProvider: true,
					callHierarchyProvider: true,
				} } });
			} else if (message.method === "workspace/symbol") {
				send(socket, { id: message.id, result: [{ name: "target", kind: 12, location: { uri }, data: { key: 1 } }] });
			} else if (message.method === "workspaceSymbol/resolve") {
				if (mode === "error") send(socket, { id: message.id, error: { code: -32001, message: "resolve failed" } });
				if (mode === "unresolved") send(socket, { id: message.id, result: { name: "target", kind: 12, location: { uri } } });
				if (mode === "invalid") send(socket, { id: message.id, result: {
					name: "target",
					kind: 12,
					location: { uri, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } },
				} });
			}
		});
		const manager = await createManager(transport, fake, { request_timeout_ms: 100 });
		await expect(queryManagerSymbols(manager, workspace, "target")).resolves.toEqual([]);
		if (expectsResolve) expect(fake.methods).toContain("workspaceSymbol/resolve");
		else expect(fake.methods).not.toContain("workspaceSymbol/resolve");
	});
	it("TCP initialize 失败时退化为 unavailable", async () => {
		const workspace = transport.workspace;
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, error: { code: -32000, message: "initialize failed" } });
			}
		});
		const manager = await createManager(transport, fake);
		await expect(queryManagerSymbols(manager, workspace, "target")).resolves.toEqual([]);
		await expect(manager.status(workspace)).resolves.toMatchObject({
			servers: [{ id: "tcp", status: "unavailable", last_error: expect.stringContaining("initialize failed") }],
		});
	});
	it("TCP session 保存 capabilities、取消请求并安全处理 server request", async () => {
		const workspace = transport.workspace;
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: { workspaceSymbolProvider: true, textDocumentSync: { openClose: true, change: 1 } } } });
				send(socket, { method: "textDocument/publishDiagnostics", params: { uri: pathToFileUri(path.join(workspace, "a.ts")), diagnostics: [] } });
				send(socket, { id: 77, method: "workspace/applyEdit", params: { edit: {} } });
			}
		});
		const config = defaultLspConfig();
		config.startup_timeout_ms = 500;
		config.request_timeout_ms = 100;
		const client = new LspClient(workspace, {
			id: "tcp",
			enabled: true,
			transport: { type: "tcp", host: "127.0.0.1", port: fake.port },
			fallback: false,
			routes: [{ languageId: "typescript", selectors: ["*.ts"] }],
			initializationOptions: ["strict", { feature: true }],
		}, config, new DiagnosticsLedger(), () => undefined);

		expect(await client.ensureReady()).toBe(true);
		expect(client.capabilities()?.workspaceSymbolProvider).toBe(true);
		await expect(client.workspaceSymbols("slow")).resolves.toBeUndefined();
		await fake.cancelled;
		await fake.response;
		await expect(client.saveAndCollectDiagnosticsBatch([{
			filePath: path.join(workspace, "a.ts"),
			text: "const a = 1;\n",
		}], {})).resolves.toMatchObject([{ kind: "publish" }]);
		await client.shutdown();
		await fake.closed;

		expect(fake.messages.find((message) => message.method === "initialize")).toMatchObject({
			params: { initializationOptions: ["strict", { feature: true }] },
		});
		expect(fake.methods).toContain("textDocument/didOpen");
		await expect(fake.response).resolves.toMatchObject({ id: 77, error: { code: -32601 } });
	});
	it("capability 不支持时不发送不适用的 feature request", async () => {
		const workspace = transport.workspace;
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {} } });
			}
		});
		const manager = await createManager(transport, fake);
		await expect(queryManagerSymbols(manager, workspace, "target")).resolves.toEqual([]);
		expect(fake.methods).not.toContain("workspace/symbol");
	});
});
