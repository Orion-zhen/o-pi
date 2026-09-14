import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../../helpers/async.js";
import { pathToFileUri } from "../../../../src/harness/lsp/protocol/uri.js";
import { createManager, createProtocolServer, diagnostic, directClient, send, useTransportFixture } from "./fixtures.js";

const transport = useTransportFixture();
const capabilities = {
	diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
	textDocumentSync: { openClose: true, change: 1, save: true },
	codeActionProvider: true,
};

function quickfix(uri: string, title = 'Import Foo from "./foo.js"') {
	return {
		title, kind: "quickfix",
		edit: { changes: { [uri]: [{
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			newText: 'import { Foo } from "./foo.js";\n',
		}] } },
	};
}

describe("lsp mutation enhancements", () => {
	it("唯一内联 quickfix 只返回提示，并原样传回诊断 data，不修改文件", async () => {
		const filePath = path.join(transport.workspace, "a.ts");
		const uri = pathToFileUri(filePath);
		const content = "Foo();\n";
		await writeFile(filePath, content);
		const original = { ...diagnostic("Cannot find name 'Foo'.", 0), data: { fixId: "missing-import" } };
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: {
				"textDocument/diagnostic": (message, socket) => send(socket, { id: message.id, result: { kind: "full", items: [original] } }),
				"textDocument/codeAction": (message, socket) => send(socket, { id: message.id, result: [quickfix(uri)] }),
			},
		});
		const manager = await createManager(transport, fake);
		const result = await manager.afterMutation({ workspaceRoot: transport.workspace, created: false, filePath, content });
		expect(result?.items[0]?.hint).toBe('Import Foo from "./foo.js"');
		expect(fake.messages.find((message) => message.method === "textDocument/codeAction")).toMatchObject({
			params: { textDocument: { uri }, context: { diagnostics: [original], only: ["quickfix"] } },
		});
		expect(fake.methods).not.toContain("workspace/executeCommand");
		expect(fake.methods).not.toContain("codeAction/resolve");
		expect(await readFile(filePath, "utf8")).toBe(content);
	});

	it.each(["ambiguous", "command", "lazy", "cross-file", "disabled", "rpc-error"] as const)("%s 操作不产生提示，也不丢失诊断", async (mode) => {
		const filePath = path.join(transport.workspace, "a.ts");
		const uri = pathToFileUri(filePath);
		const action = quickfix(uri);
		const actions = mode === "ambiguous" ? [action, quickfix(uri, 'Import Foo from "./other.js"')]
			: mode === "command" ? [{ ...action, command: { title: "fix", command: "apply-fix" } }]
			: mode === "lazy" ? [{ title: "Import Foo", kind: "quickfix", data: 42 }]
			: mode === "cross-file" ? [quickfix(pathToFileUri(path.join(transport.workspace, "other.ts")))]
			: mode === "disabled" ? [{ ...action, disabled: { reason: "not applicable" } }]
			: [];
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: {
				"textDocument/diagnostic": (message, socket) => send(socket, { id: message.id, result: { kind: "full", items: [diagnostic("Cannot find name 'Foo'.", 0)] } }),
				"textDocument/codeAction": (message, socket) => send(socket, mode === "rpc-error"
					? { id: message.id, error: { code: -32603, message: "action failed" } }
					: { id: message.id, result: actions }),
			},
		});
		const manager = await createManager(transport, fake);
		const result = await manager.afterMutation({ workspaceRoot: transport.workspace, created: false, filePath, content: "Foo();\n" });
		expect(result).toMatchObject({ status: "errors", items: [{ message: "Cannot find name 'Foo'." }] });
		expect(result?.items[0]).not.toHaveProperty("hint");
		expect(fake.methods).not.toContain("workspace/executeCommand");
	});

	it.each(["write", "edit"] as const)("%s 重复展示原有错误，但不重复请求修复提示", async (tool) => {
		const filePath = path.join(transport.workspace, "a.ts");
		const uri = pathToFileUri(filePath);
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: {
				"textDocument/diagnostic": (message, socket) => send(socket, { id: message.id, result: { kind: "full", items: [diagnostic("missing Foo", 0)] } }),
				"textDocument/codeAction": (message, socket) => send(socket, { id: message.id, result: [quickfix(uri)] }),
			},
		});
		const manager = await createManager(transport, fake);
		await manager.afterMutation({ workspaceRoot: transport.workspace, created: false, filePath, content: "Foo();\n" });
		const baseline = await manager.beforeMutation({ workspaceRoot: transport.workspace, filePath });
		if (baseline === undefined) throw new Error("missing baseline");
		const result = await manager.afterMutation({
			workspaceRoot: transport.workspace, created: false, filePath, content: "Foo();\nconst value = 1;\n", baseline,
			...(tool === "edit" ? { changed_ranges: [{ start_line: 2, end_line: 2 }] } : {}),
		});
		expect(result?.items[0]).toMatchObject({ message: "missing Foo", change: "existing" });
		expect(result?.items[0]).not.toHaveProperty("hint");
		expect(fake.methods.filter((method) => method === "textDocument/codeAction")).toHaveLength(1);
	});

	it("每个文件最多为三个可见错误请求提示，警告不占名额", async () => {
		const filePath = path.join(transport.workspace, "a.ts");
		const uri = pathToFileUri(filePath);
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: {
				"textDocument/diagnostic": (message, socket) => send(socket, { id: message.id, result: { kind: "full", items: [
					{ ...diagnostic("unused value", 0), severity: 2 },
					...Array.from({ length: 4 }, (_, line) => diagnostic(`missing value ${line}`, line + 1)),
				] } }),
				"textDocument/codeAction": (message, socket) => send(socket, { id: message.id, result: [quickfix(uri)] }),
			},
		});
		const manager = await createManager(transport, fake);
		const result = await manager.afterMutation({ workspaceRoot: transport.workspace, created: false, filePath, content: "let value = 1;\nFoo();\nBar();\nBaz();\nQux();\n" });
		expect(result?.items.filter((item) => item.hint !== undefined)).toHaveLength(3);
		expect(fake.methods.filter((method) => method === "textDocument/codeAction")).toHaveLength(3);
	});

	it("修复提示超时只取消提示请求，不改变已取得的诊断", async () => {
		const filePath = path.join(transport.workspace, "a.ts");
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: {
				"textDocument/diagnostic": (message, socket) => send(socket, { id: message.id, result: { kind: "full", items: [diagnostic("missing Foo", 0)] } }),
				"textDocument/codeAction": () => {},
			},
		});
		const manager = await createManager(transport, fake, { diagnostics: { max_wait_ms: 50 } });
		const result = await manager.afterMutation({ workspaceRoot: transport.workspace, created: false, filePath, content: "Foo();\n" });
		expect(result).toMatchObject({ status: "errors", items: [{ message: "missing Foo" }] });
		expect(result?.items[0]).not.toHaveProperty("hint");
		await fake.cancelled;
	});

	it("后续修改已同步时，不为旧正文请求修复提示", async () => {
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: { "textDocument/diagnostic": (message, socket) => send(socket, { id: message.id, result: { kind: "full", items: [] } }) },
		});
		const client = directClient(transport, fake);
		const filePath = path.join(transport.workspace, "a.ts");
		await client.saveAndCollectDiagnosticsBatch([{ filePath, text: "const fixed = 1;\n" }], {});
		expect(await client.diagnosticHints(filePath, "Foo();\n", [{ severity: "error", line: 1, column: 1, message: "missing Foo" }], { timeoutMs: 300 })).toEqual([]);
		expect(fake.methods).not.toContain("textDocument/codeAction");
	});

	it("提示预算包含同文件队列等待，不阻塞在下一次修改的诊断后面", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		let pulls = 0;
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: { "textDocument/diagnostic": (message, socket) => {
				const respond = () => send(socket, { id: message.id, result: { kind: "full", items: [] } });
				if (++pulls === 1) respond();
				else { entered.resolve(); void release.promise.then(respond); }
			} },
		});
		const client = directClient(transport, fake);
		const filePath = path.join(transport.workspace, "a.ts");
		await client.saveAndCollectDiagnosticsBatch([{ filePath, text: "Foo();\n" }], {});
		const saving = client.saveAndCollectDiagnosticsBatch([{ filePath, text: "fixed();\n" }], { timeoutMs: 3000 });
		await entered.promise;
		vi.useFakeTimers();
		let completed = false;
		const hints = client.diagnosticHints(filePath, "Foo();\n", [{ severity: "error", line: 1, column: 1, message: "missing Foo" }], { timeoutMs: 20 })
			.then((value) => { completed = true; return value; });
		try {
			await vi.advanceTimersByTimeAsync(21);
			expect(completed).toBe(true);
			expect(await hints).toEqual([]);
		} finally {
			vi.useRealTimers();
			release.resolve();
			await saving;
			await hints;
		}
		expect(fake.methods).not.toContain("textDocument/codeAction");
	});

	it("关联报告只返回新增错误，未知基线标记不确定，并限制文件数和总条数", async () => {
		const root = transport.workspace;
		const filePath = path.join(root, "api.ts");
		const callerUri = pathToFileUri(path.join(root, "a-caller.ts"));
		const report = (message: string, line: number) => ({ kind: "full", items: [diagnostic(message, line)] });
		let pulls = 0;
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: { "textDocument/diagnostic": (message, socket) => {
				pulls += 1;
				send(socket, { id: message.id, result: { kind: "full", items: [], relatedDocuments: pulls === 1
					? { [callerUri]: report("old error", 0) }
					: {
						[callerUri]: { kind: "full", items: [diagnostic("old error", 4), diagnostic("argument type changed", 5)] },
						...Object.fromEntries(["b", "c", "d", "e"].map((name) => [pathToFileUri(path.join(root, `${name}.ts`)), report("newly observed error", 0)])),
						[pathToFileUri(path.join(root, "../outside.ts"))]: report("outside error", 0),
					},
				} });
			} },
		});
		const manager = await createManager(transport, fake, { diagnostics: { max_items: 3 } });
		await manager.afterMutation({ workspaceRoot: root, created: false, filePath, content: "export function api(value: string) {}\n" });
		const baseline = await manager.beforeMutation({ workspaceRoot: root, filePath });
		if (baseline === undefined) throw new Error("missing baseline");
		const result = await manager.afterMutation({ workspaceRoot: root, created: false, filePath, content: "export function api(value: number) {}\n", baseline });
		expect(result).toMatchObject({ status: "clean", items: [], related: [
			{ path: "a-caller.ts", baseline: "known", items: [{ message: "argument type changed" }] },
			{ path: "b.ts", baseline: "unknown", items: [{ message: "newly observed error" }] },
			{ path: "c.ts", baseline: "unknown", items: [{ message: "newly observed error" }] },
		] });
		expect(result?.related).toHaveLength(3);
		expect(fake.methods.filter((method) => method === "textDocument/diagnostic")).toHaveLength(2);
		expect(fake.methods).not.toContain("workspace/diagnostic");
	});

	it("同批次关联诊断去重，并排除本批次已修改的文件", async () => {
		const root = transport.workspace;
		const a = path.join(root, "a.ts");
		const b = path.join(root, "b.ts");
		const callerUri = pathToFileUri(path.join(root, "caller.ts"));
		const fake = await createProtocolServer(transport, {
			capabilities,
			routes: { "textDocument/diagnostic": (message, socket) => send(socket, {
				id: message.id, result: { kind: "full", items: [], relatedDocuments: {
					[callerUri]: { kind: "full", items: [diagnostic("caller error", 0)] },
					[pathToFileUri(b)]: { kind: "full", items: [diagnostic("intermediate error", 0)] },
				} },
			}) },
		});
		const manager = await createManager(transport, fake);
		const results = await manager.afterMutationBatch([a, b].map((filePath) => ({ workspaceRoot: root, created: false, filePath, content: "export const value = 1;\n" })));
		expect(results.flatMap((result) => result?.related ?? [])).toEqual([
			{ path: "caller.ts", baseline: "unknown", items: [expect.objectContaining({ message: "caller error" })] },
		]);
	});
});
