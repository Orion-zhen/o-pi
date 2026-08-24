import path from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticsLedger } from "../../../src/lsp/diagnostics/ledger.js";
import { pathToFileUri } from "../../../src/lsp/protocol/uri.js";
import { deferred } from "../../helpers/async.js";
import { createManager, createProtocolServer, diagnostic, directClient, send, useTransportFixture } from "./fixtures.js";

const transport = useTransportFixture();

describe("lsp transport diagnostics", () => {
	it("publishDiagnostics 丢弃旧文档版本，未打开或无 version 时仍接受", async () => {
		const workspace = transport.workspace;
		const uri = pathToFileUri(path.join(workspace, "a.ts"));
		const publish = (socket: Parameters<typeof send>[0], version: number | undefined, message: string) => send(socket, {
			method: "textDocument/publishDiagnostics",
			params: { uri, ...(version === undefined ? {} : { version }), diagnostics: [diagnostic(message, 0)] },
		});
		const fake = await createProtocolServer(transport, {
			capabilities: { textDocumentSync: { openClose: true, change: 1 } },
			afterInitialize: (_message, socket) => publish(socket, 5, "workspace"),
			routes: { "textDocument/didOpen": (_message, socket) => {
				publish(socket, 0, "stale");
				publish(socket, 1, "current");
				publish(socket, undefined, "unversioned");
			} },
		});
		const diagnostics = new DiagnosticsLedger();
		const client = directClient(transport, fake, 64, undefined, diagnostics);
		expect(await client.ensureReady()).toBe(true);
		await expect(client.saveAndCollectDiagnosticsBatch([{
			filePath: path.join(workspace, "a.ts"),
			text: "const a = 1;\n",
		}], {})).resolves.toMatchObject([{ kind: "publish" }]);
		await client.shutdown();
		expect(diagnostics.snapshot(client.diagnosticSource(), uri).items).toEqual([
			expect.objectContaining({ message: "unversioned" }),
		]);
	});
	it("didWrite 优先 pull diagnostics，复用 resultId 并保存 related documents", async () => {
		const workspace = transport.workspace;
		const uri = pathToFileUri(path.join(workspace, "a.ts"));
		const relatedUri = pathToFileUri(path.join(workspace, "related.ts"));
		let pulls = 0;
		const fake = await createProtocolServer(transport, {
			capabilities: {
				diagnosticProvider: { identifier: "typescript", interFileDependencies: true, workspaceDiagnostics: false },
				textDocumentSync: { openClose: true, change: 1, save: true },
			},
			routes: { "textDocument/diagnostic": (message, socket) => {
				pulls += 1;
				if (pulls === 1) {
					send(socket, { id: message.id, result: {
						kind: "full",
						resultId: "current-r1",
						items: [diagnostic("pulled error", 1)],
						relatedDocuments: {
							[relatedUri]: {
								kind: "full",
								resultId: "related-r1",
								items: [diagnostic("related error", 2)],
							},
						},
					} });
				} else send(socket, { id: message.id, result: { kind: "unchanged", resultId: "current-r1" } });
			} },
		});
		const manager = await createManager(transport, fake, { diagnostics: { enabled: true, max_wait_ms: 100, settle_ms: 0, max_items: 8, max_related_locations: 2, min_severity: "warning" } });
		const file = path.join(workspace, "a.ts");
		await expect(manager.didWrite(workspace, file, "const a = 1;\n")).resolves.toMatchObject({
			status: "errors",
			items: [{ message: "pulled error" }],
		});
		const baseline = await manager.beforeDiagnostics(workspace, file);
		await expect(manager.didWrite(workspace, file, "const a = 2;\n", baseline)).resolves.toMatchObject({
			status: "errors",
			new_errors: 0,
			items: [{ message: "pulled error" }],
		});
		await expect(manager.knownDiagnostics(workspace, "related.ts")).resolves.toEqual([
			{ path: "related.ts", items: [expect.objectContaining({ message: "related error" })] },
		]);
		const requests = fake.messages.filter((message) => message.method === "textDocument/diagnostic");
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ params: { textDocument: { uri }, identifier: "typescript" } });
		expect(requests[0]?.params).not.toHaveProperty("previousResultId");
		expect(requests[1]).toMatchObject({ params: { textDocument: { uri }, identifier: "typescript", previousResultId: "current-r1" } });
		expect(fake.methods).not.toContain("workspace/executeCommand");
	});
	it("didWriteBatch 先同步同一 server 的全部文档，并限制并发 pull diagnostics", async () => {
		const workspace = transport.workspace;
		let opened = 0;
		let pulls = 0;
		const firstPullBatch = deferred<void>();
		const firstPullGate = deferred<void>();
		const fake = await createProtocolServer(transport, {
			capabilities: {
				diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
				textDocumentSync: { openClose: true, change: 1, save: true },
			},
			routes: {
				"textDocument/didOpen": () => { opened += 1; },
				"textDocument/diagnostic": (message, socket) => {
				pulls += 1;
				const respond = () => send(socket, { id: message.id, result: { kind: "full", resultId: `r${pulls}`, items: [] } });
				if (pulls <= 4) {
					if (pulls === 4) firstPullBatch.resolve();
					void firstPullGate.promise.then(respond);
				} else respond();
				},
			},
		});
		const manager = await createManager(transport, fake, { diagnostics: { enabled: true, max_wait_ms: 1000, settle_ms: 0, max_items: 8, max_related_locations: 2, min_severity: "warning" } });
		const pending = manager.didWriteBatch(Array.from({ length: 5 }, (_, index) => ({
			root: workspace,
			filePath: path.join(workspace, `${index}.ts`),
			text: `export const value${index} = ${index};\n`,
		})));

		await firstPullBatch.promise;
		expect(opened).toBe(5);
		expect(pulls).toBe(4);
		firstPullGate.resolve();
		await expect(pending).resolves.toEqual(Array.from({ length: 5 }, () => expect.objectContaining({ status: "clean" })));
		expect(pulls).toBe(5);
	});
	it("didWrite 只接受 captured revision 之后的 diagnostics，旧快照不能伪装成功", async () => {
		const workspace = transport.workspace;
		const uri = pathToFileUri(path.join(workspace, "a.ts"));
		const fake = await createProtocolServer(transport, {
			capabilities: { textDocumentSync: { openClose: true, change: 1, save: true } },
			routes: { "textDocument/didOpen": (_message, socket) => {
				send(socket, { method: "textDocument/publishDiagnostics", params: {
					uri, version: 1, diagnostics: [diagnostic("new error", 1)],
				} });
			} },
		});
		const manager = await createManager(transport, fake, { diagnostics: { enabled: true, max_wait_ms: 100, settle_ms: 0, max_items: 8, min_severity: "warning" } });
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
		expect(fake.methods).not.toContain("textDocument/diagnostic");
	});
});
