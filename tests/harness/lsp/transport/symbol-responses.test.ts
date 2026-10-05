import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceSymbol } from "vscode-languageserver-protocol";
import { pathToFileUri } from "../../../../src/harness/lsp/protocol/uri.ts";
import { createProtocolServer, directClient, send, useTransportFixture } from "./fixtures.ts";

const transport = useTransportFixture();
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
const symbol = { name: "Target", kind: 12, range, selectionRange: range };

describe("LSP symbol response boundaries", () => {
	it.each([
		{ name: "非数组响应", result: {} },
		{ name: "非字符串名称", result: [{ ...symbol, name: null }] },
		{ name: "损坏的子符号", result: [{ ...symbol, children: [null] }] },
		{ name: "缺少位置的平面符号", result: [{ name: "Target", kind: 12 }] },
	])("文档符号在协议边界拒绝$name", async ({ result }) => {
		const server = await createProtocolServer(transport, {
			capabilities: { documentSymbolProvider: true },
			routes: { "textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result }) },
		});
		const client = directClient(transport, server);
		await expect(client.documentSymbols(path.join(transport.workspace, "main.ts"), "Target\n")).resolves.toBeUndefined();
	});

	it("工作区符号过滤损坏条目，保留完整位置和待解析候选", async () => {
		const uri = pathToFileUri(path.join(transport.workspace, "main.ts"));
		const complete = { name: "Target", kind: 12, location: { uri, range } };
		const pending: WorkspaceSymbol = { name: "Pending", kind: 12, location: { uri }, data: { id: 1 } };
		const server = await createProtocolServer(transport, {
			capabilities: { workspaceSymbolProvider: { resolveProvider: true } },
			routes: {
				"workspace/symbol": (message, socket) => send(socket, { id: message.id, result: [
					null, complete, { ...complete, name: 7 }, { ...complete, location: { uri, range: null } }, pending,
				] }),
				"workspaceSymbol/resolve": (message, socket) => send(socket, { id: message.id, result: { ...pending, location: null } }),
			},
		});
		const client = directClient(transport, server);
		await expect(client.workspaceSymbols("Target")).resolves.toEqual([complete, pending]);
		await expect(client.resolveWorkspaceSymbol(pending)).resolves.toBeUndefined();
	});

	it("工作区符号非数组响应不冒充成功空结果", async () => {
		const server = await createProtocolServer(transport, {
			capabilities: { workspaceSymbolProvider: true },
			routes: { "workspace/symbol": (message, socket) => send(socket, { id: message.id, result: {} }) },
		});
		await expect(directClient(transport, server).workspaceSymbols("Target")).resolves.toBeUndefined();
	});
});
