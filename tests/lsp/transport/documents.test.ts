import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeServer, deferred, directClient, documentSymbol, send, useTransportFixture } from "./fixtures.js";

const transport = useTransportFixture();

describe("lsp transport documents", () => {
	it("同文档并发同步保序、内容未变复用 documentSymbol cache", async () => {
		const workspace = transport.workspace;
		let documentSymbolRequests = 0;
		const firstRequest = deferred<void>();
		const firstRequestGate = deferred<void>();
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					documentSymbolProvider: true,
					textDocumentSync: { openClose: true, change: 1, save: true },
				} } });
			} else if (message.method === "textDocument/documentSymbol") {
				documentSymbolRequests += 1;
				const response = () => send(socket, { id: message.id, result: [documentSymbol("target", documentSymbolRequests)] });
				if (documentSymbolRequests === 1) {
					firstRequest.resolve();
					void firstRequestGate.promise.then(response);
				} else {
					response();
				}
			}
		});
		const client = directClient(transport, fake);
		expect(await client.ensureReady()).toBe(true);
		const file = path.join(workspace, "a.ts");
		const first = client.documentSymbols(file, "const target = 1;\n");
		const second = client.documentSymbols(file, "const target = 2;\n");
		await firstRequest.promise;
		expect(fake.methods).not.toContain("textDocument/didChange");
		firstRequestGate.resolve();
		const [firstSymbols, secondSymbols] = await Promise.all([first, second]);
		expect(firstSymbols?.[0]?.name).toBe("target");
		expect(secondSymbols?.[0]?.name).toBe("target");

		expect(client.status().open_documents).toBe(0);
		const beforeWarmRead = fake.methods.length;
		await expect(client.documentSymbols(file, "const target = 2;\n")).resolves.toEqual(secondSymbols);
		expect(fake.methods).toHaveLength(beforeWarmRead);
		await expect(client.saveAndCollectDiagnosticsBatch([{ filePath: file, text: "const target = 2;\n" }], {})).resolves.toMatchObject([{ kind: "publish" }]);
		await client.shutdown();

		const documentMethods = fake.methods.filter((method) => method.startsWith("textDocument/"));
		expect(documentMethods).toEqual([
			"textDocument/didOpen",
			"textDocument/documentSymbol",
			"textDocument/didChange",
			"textDocument/documentSymbol",
			"textDocument/didClose",
			"textDocument/didOpen",
			"textDocument/didSave",
		]);
		expect(fake.messages.find((message) => message.method === "textDocument/didChange")).toMatchObject({
			params: {
				textDocument: { version: 2 },
				contentChanges: [{ text: "const target = 2;\n" }],
			},
		});
		const saveParams = fake.messages.filter((message) => message.method === "textDocument/didSave").at(-1)?.params;
		expect(saveParams).not.toHaveProperty("text");
	});
	it("incremental sync 使用 UTF-16 range，language route 与 save includeText 生效", async () => {
		const workspace = transport.workspace;
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
				} } });
			}
		});
		const client = directClient(transport, fake);
		expect(await client.ensureReady()).toBe(true);
		const file = path.join(workspace, "a.tsx");
		const previous = "const 😀x = 1;\r\n";
		const next = "const 😀x = 2;\r\n";
		await expect(client.saveAndCollectDiagnosticsBatch([{ filePath: file, text: previous }], {})).resolves.toMatchObject([{ kind: "publish" }]);
		await expect(client.saveAndCollectDiagnosticsBatch([{ filePath: file, text: next }], {})).resolves.toMatchObject([{ kind: "publish" }]);
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
		expect(fake.messages.filter((message) => message.method === "textDocument/didSave").at(-1)).toMatchObject({
			params: { text: next },
		});
	});
	it("textDocumentSync None 不发送 open/change/save/close", async () => {
		const workspace = transport.workspace;
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					textDocumentSync: { openClose: false, change: 0, save: false },
				} } });
			}
		});
		const client = directClient(transport, fake);
		expect(await client.ensureReady()).toBe(true);
		const file = path.join(workspace, "a.ts");
		await expect(client.saveAndCollectDiagnosticsBatch([{ filePath: file, text: "one\n" }], {})).resolves.toMatchObject([{ kind: "publish" }]);
		await expect(client.saveAndCollectDiagnosticsBatch([{ filePath: file, text: "two\n" }], {})).resolves.toMatchObject([{ kind: "publish" }]);
		await client.shutdown();
		expect(fake.methods.filter((method) => method.startsWith("textDocument/"))).toEqual([]);
	});
	it("documentSymbol 临时关闭文档，并按 LRU 清除旧 symbol cache", async () => {
		const workspace = transport.workspace;
		const fake = await createFakeServer(transport, (message, socket) => {
			if (message.method === "initialize") {
				send(socket, { id: message.id, result: { capabilities: {
					documentSymbolProvider: true,
					textDocumentSync: { openClose: true, change: 1 },
				} } });
			} else if (message.method === "textDocument/documentSymbol") {
				send(socket, { id: message.id, result: [documentSymbol("target", 0)] });
			}
		});
		const client = directClient(transport, fake, 1);
		expect(await client.ensureReady()).toBe(true);
		const first = path.join(workspace, "a.ts");
		const second = path.join(workspace, "b.ts");
		await client.documentSymbols(first, "const a = 1;\n");
		await client.documentSymbols(second, "const b = 1;\n");
		await client.documentSymbols(first, "const a = 1;\n");
		await client.shutdown();

		expect(fake.methods.filter((method) => method.startsWith("textDocument/"))).toEqual([
			"textDocument/didOpen",
			"textDocument/documentSymbol",
			"textDocument/didClose",
			"textDocument/didOpen",
			"textDocument/documentSymbol",
			"textDocument/didClose",
			"textDocument/didOpen",
			"textDocument/documentSymbol",
			"textDocument/didClose",
		]);
		expect(client.status().open_documents).toBe(0);
	});
});
