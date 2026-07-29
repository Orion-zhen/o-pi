import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileToolsExtension, type FileToolsModuleImports } from "../../agent/extensions/file-tools.js";
import { lspManager } from "../../src/lsp/index.js";
import type { LspMutationInput } from "../../src/lsp/file-hooks.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { activateFileTools, executeTool, type ExecuteTool, type LifecycleHandler } from "./extension-fixture.js";

describe("file-tools extension lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("RPC 保留文件工具但不加载 native renderer", async () => {
		const registered: Array<{ name: string; renderCall?: unknown; renderResult?: unknown }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const loadRenderers = vi.fn(async () => {
			throw new Error("renderer must not load");
		});
		const extension = createFileToolsExtension({
			ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
			host: () => import("../../src/file-tools/runtime/host.js"),
			find: () => import("../../src/file-tools/pi/adapters/find.js"),
			grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
			read: () => import("../../src/file-tools/pi/adapters/read.js"),
			write: () => import("../../src/file-tools/pi/adapters/write.js"),
			edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
			lsp: () => import("../../src/lsp/index.js"),
			renderers: loadRenderers,
		});
		extension({
			registerTool(tool: { name: string; renderCall?: unknown; renderResult?: unknown }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"), "rpc");

		expect(loadRenderers).not.toHaveBeenCalled();
		expect(registered.map((tool) => tool.name)).toEqual(["ls", "find", "grep", "read", "write", "edit"]);
		expect(registered.every((tool) => tool.renderCall === undefined && tool.renderResult === undefined)).toBe(true);
	});

	it("注册阶段零预热，首次执行按工具加载，并发复用且失败可重试", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const disposeHost = vi.spyOn(FileToolsHost.prototype, "dispose");
		let resolveLs: ((module: typeof import("../../src/file-tools/pi/adapters/ls.js")) => void) | undefined;
		const pendingLs = new Promise<typeof import("../../src/file-tools/pi/adapters/ls.js")>((resolve) => {
			resolveLs = resolve;
		});
		let findLoadAttempts = 0;
		const imports = {
			ls: vi.fn(() => pendingLs),
			host: vi.fn(() => import("../../src/file-tools/runtime/host.js")),
			find: vi.fn(() => {
				findLoadAttempts += 1;
				return findLoadAttempts === 1
					? Promise.reject(new Error("simulated import failure"))
					: import("../../src/file-tools/pi/adapters/find.js");
			}),
			grep: vi.fn(() => import("../../src/file-tools/pi/adapters/grep.js")),
			read: vi.fn(() => import("../../src/file-tools/pi/adapters/read.js")),
			write: vi.fn(() => import("../../src/file-tools/pi/adapters/write.js")),
			edit: vi.fn(() => import("../../src/file-tools/pi/adapters/edit.js")),
			lsp: vi.fn(() => import("../../src/lsp/index.js")),
		} satisfies FileToolsModuleImports;
		const extension = createFileToolsExtension(imports);
		const pi = {
			registerTool(tool: { name: string; execute?: ExecuteTool }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) {
				handlers.set(name, handler);
			},
		};
		extension(pi as unknown as ExtensionAPI);

		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
		expect(handlers.has("before_agent_start")).toBe(false);
		expect(imports.ls).not.toHaveBeenCalled();
		expect(imports.host).not.toHaveBeenCalled();
		expect(imports.find).not.toHaveBeenCalled();
		expect(imports.grep).not.toHaveBeenCalled();
		expect(imports.read).not.toHaveBeenCalled();
		expect(imports.write).not.toHaveBeenCalled();
		expect(imports.edit).not.toHaveBeenCalled();
		expect(imports.lsp).not.toHaveBeenCalled();

		const ctx = {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "lazy-session", getBranch: () => [] },
		};
		const firstLs = executeTool(registered, "ls", {}, ctx);
		const secondLs = executeTool(registered, "ls", {}, ctx);
		expect(imports.ls).toHaveBeenCalledTimes(1);

		if (resolveLs === undefined) throw new Error("missing ls module resolver");
		resolveLs(await import("../../src/file-tools/pi/adapters/ls.js"));
		await expect(firstLs).resolves.toMatchObject({ details: { path: "." } });
		await expect(secondLs).resolves.toMatchObject({ details: { path: "." } });
		expect(imports.ls).toHaveBeenCalledTimes(1);
		expect(imports.host).toHaveBeenCalledTimes(1);

		await expect(executeTool(registered, "find", { query: "package.json", path: ["."] }, ctx)).rejects.toThrow("simulated import failure");
		await expect(executeTool(registered, "find", { query: "package.json", path: ["."] }, ctx)).resolves.toMatchObject({
			details: { query: "package.json" },
		});
		expect(imports.find).toHaveBeenCalledTimes(2);
		await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
		expect(imports.lsp).not.toHaveBeenCalled();
		expect(imports.grep).not.toHaveBeenCalled();
		expect(imports.read).not.toHaveBeenCalled();
		expect(imports.write).not.toHaveBeenCalled();
		expect(imports.edit).not.toHaveBeenCalled();
		expect(disposeHost).toHaveBeenCalledTimes(1);
	});

	it("同一 factory 创建新 session 时重建已释放的 find 和 grep adapter", async () => {
		const imports = {
			ls: vi.fn(() => import("../../src/file-tools/pi/adapters/ls.js")),
			host: vi.fn(() => import("../../src/file-tools/runtime/host.js")),
			find: vi.fn(() => import("../../src/file-tools/pi/adapters/find.js")),
			grep: vi.fn(() => import("../../src/file-tools/pi/adapters/grep.js")),
			read: vi.fn(() => import("../../src/file-tools/pi/adapters/read.js")),
			write: vi.fn(() => import("../../src/file-tools/pi/adapters/write.js")),
			edit: vi.fn(() => import("../../src/file-tools/pi/adapters/edit.js")),
			lsp: vi.fn(() => import("../../src/lsp/index.js")),
		} satisfies FileToolsModuleImports;
		const extension = createFileToolsExtension(imports);
		const createSession = () => {
			const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
			const handlers = new Map<string, LifecycleHandler>();
			extension({
				registerTool(tool: { name: string; execute?: ExecuteTool }) { registered.push(tool); },
				on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
			} as unknown as ExtensionAPI);
			return { registered, handlers };
		};
		const executeSearchTools = async (registered: Array<{ name: string; execute?: ExecuteTool }>, sessionId: string) => {
			const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => sessionId } };
			await expect(executeTool(registered, "find", { query: "package.json", path: ["."] }, ctx)).resolves.toMatchObject({
				details: { query: "package.json" },
			});
			await expect(executeTool(registered, "grep", {
				query: "createFileToolsExtension",
				path: ["agent/extensions/file-tools.ts"],
							}, ctx)).resolves.toMatchObject({ details: { status: "success" } });
		};

		const first = createSession();
		await executeSearchTools(first.registered, "search-session-1");
		await expect(Promise.resolve(first.handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();

		const second = createSession();
		try {
			await executeSearchTools(second.registered, "search-session-2");
			expect(imports.find).toHaveBeenCalledTimes(2);
			expect(imports.grep).toHaveBeenCalledTimes(2);
		} finally {
			await Promise.resolve(second.handlers.get("session_shutdown")?.({}, {}));
		}
	});

	it("并发 write 批次先完成全部提交，再统一执行 LSP diagnostics", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const directLsp = vi.fn(async () => undefined);
		const batchLsp = vi.fn(async (inputs: readonly LspMutationInput[]) => {
			expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("export const a = 1;\n");
			expect(await readFile(join(cwd, "b.ts"), "utf8")).toBe("export const b = 2;\n");
			return inputs.map((input) => input.filePath.endsWith("a.ts") ? diagnostics("errors", "a failed") : diagnostics("warnings", "b warned"));
		});
		const imports = {
			ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
			host: () => import("../../src/file-tools/runtime/host.js"),
			find: () => import("../../src/file-tools/pi/adapters/find.js"),
			grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
			read: () => import("../../src/file-tools/pi/adapters/read.js"),
			write: () => import("../../src/file-tools/pi/adapters/write.js"),
			edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
			async lsp() {
				return {
					...(await import("../../src/lsp/index.js")),
					lspFileOperations: { afterWrite: directLsp, afterWriteBatch: batchLsp },
				};
			},
		} satisfies FileToolsModuleImports;
		createFileToolsExtension(imports)({
			registerTool(tool: { name: string; execute?: ExecuteTool }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
			appendEntry() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-mutation-batch-"));
		const ctx = { cwd, sessionManager: { getSessionId: () => "mutation-batch", getBranch: () => [] } };
		const write = registered.find((tool) => tool.name === "write")?.execute;
		const edit = registered.find((tool) => tool.name === "edit")?.execute;
		const read = registered.find((tool) => tool.name === "read")?.execute;
		if (write === undefined || edit === undefined || read === undefined) throw new Error("mutation tools not registered");
		try {
			await writeFile(join(cwd, "b.ts"), "export const b = 1;\n");
			await read("read-b", { path: "b.ts" }, undefined, undefined, ctx);
			await announceMutationBatch(handlers, [
				{ id: "write-a", name: "write" },
				{ id: "edit-b", name: "edit" },
			]);
			const [a, b] = await Promise.all([
				write("write-a", { path: "a.ts", content: "export const a = 1;\n" }, undefined, undefined, ctx),
				edit("edit-b", { path: "b.ts", edits: [{ old: "b = 1", new: "b = 2" }] }, undefined, undefined, ctx),
			]);
			expect(batchLsp).toHaveBeenCalledTimes(1);
			expect(directLsp).not.toHaveBeenCalled();
			expect(a.details).toMatchObject({ status: "written", path: "a.ts", lsp: { diagnostics: { status: "errors", items: [{ message: "a failed" }] } } });
			expect(b.details).toMatchObject({ status: "applied", path: "b.ts", lsp: { diagnostics: { status: "warnings", items: [{ message: "b warned" }] } } });
			expect(a.content[0]?.text).toContain("a failed");
			expect(a.content[0]?.text).not.toContain("b warned");
			expect(b.content[0]?.text).toContain("b warned");
			expect(b.content[0]?.text).not.toContain("a failed");
			expect(a.content[0]?.text).toContain("a.ts");
			expect(b.content[0]?.text).toContain("b.ts");
			await endMutationBatch(handlers, ["write-a", "edit-b"]);

			await announceMutationBatch(handlers, [
				{ id: "write-invalid", name: "write" },
				{ id: "write-valid", name: "write" },
			]);
			const [invalid, valid] = await Promise.all([
				write("write-invalid", { path: ".", content: "invalid" }, undefined, undefined, ctx),
				write("write-valid", { path: "valid.ts", content: "valid\n" }, undefined, undefined, ctx),
			]);
			expect(invalid.details).toMatchObject({ status: "failed" });
			expect(valid.details).toMatchObject({ status: "written", path: "valid.ts" });
			expect(batchLsp).toHaveBeenCalledTimes(2);
			expect(batchLsp.mock.calls[1]?.[0]).toHaveLength(1);
		} finally {
			await Promise.resolve(handlers.get("session_shutdown")?.({}, {}));
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("顺序执行的 mutation 调用保持逐项后处理且不会等待尚未启动的调用", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const directLsp = vi.fn(async () => diagnostics("clean", ""));
		const batchLsp = vi.fn(async () => []);
		const imports = {
			ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
			host: () => import("../../src/file-tools/runtime/host.js"),
			find: () => import("../../src/file-tools/pi/adapters/find.js"),
			grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
			read: () => import("../../src/file-tools/pi/adapters/read.js"),
			write: () => import("../../src/file-tools/pi/adapters/write.js"),
			edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
			async lsp() {
				return { ...(await import("../../src/lsp/index.js")), lspFileOperations: { afterWrite: directLsp, afterWriteBatch: batchLsp } };
			},
		} satisfies FileToolsModuleImports;
		createFileToolsExtension(imports)({
			registerTool(tool: { name: string; execute?: ExecuteTool }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		const cwd = await mkdtemp(join(tmpdir(), "o-pi-sequential-mutation-"));
		const ctx = { cwd, sessionManager: { getSessionId: () => "sequential-mutation", getBranch: () => [] } };
		const write = registered.find((tool) => tool.name === "write")?.execute;
		if (write === undefined) throw new Error("write tool not registered");
		try {
			await Promise.resolve(handlers.get("message_end")?.({ message: assistantToolMessage([
				{ id: "sequential-a", name: "write" },
				{ id: "sequential-b", name: "write" },
			]) }));
			await Promise.resolve(handlers.get("tool_execution_start")?.({ toolCallId: "sequential-a" }));
			await expect(write("sequential-a", { path: "a.ts", content: "a\n" }, undefined, undefined, ctx)).resolves.toMatchObject({ details: { status: "written" } });
			await Promise.resolve(handlers.get("tool_execution_start")?.({ toolCallId: "sequential-b" }));
			await expect(write("sequential-b", { path: "b.ts", content: "b\n" }, undefined, undefined, ctx)).resolves.toMatchObject({ details: { status: "written" } });
			expect(directLsp).toHaveBeenCalledTimes(2);
			expect(batchLsp).not.toHaveBeenCalled();
		} finally {
			await Promise.resolve(handlers.get("session_shutdown")?.({}, {}));
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("完整 read 不加载 LSP，局部 read 首次请求增强时才加载并复用", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const reload = vi.spyOn(lspManager, "reload").mockResolvedValue();
		const enhanceRead = vi.fn(async () => ({
			enclosing_symbol: { name: "value", kind: "declaration", line: 1, end_line: 3 },
		}));
		const imports = {
			ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
			host: () => import("../../src/file-tools/runtime/host.js"),
			find: () => import("../../src/file-tools/pi/adapters/find.js"),
			grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
			read: vi.fn(() => import("../../src/file-tools/pi/adapters/read.js")),
			write: () => import("../../src/file-tools/pi/adapters/write.js"),
			edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
			lsp: vi.fn(async () => ({ ...(await import("../../src/lsp/index.js")), lspFileOperations: { read: enhanceRead } })),
		} satisfies FileToolsModuleImports;
		const getCommands = vi.fn(() => []);
		createFileToolsExtension(imports)({
			registerTool(tool: { name: string; execute?: ExecuteTool }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) {
				handlers.set(name, handler);
			},
			getCommands,
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-lazy-read-"));
		try {
			await writeFile(join(cwd, "a.ts"), "export const value = 1;\nexport const next = 2;\nexport const last = 3;\n");
			const ctx = { cwd, sessionManager: { getSessionId: () => "lazy-read", getBranch: () => [] } };
			await executeTool(registered, "read", { path: "a.ts" }, ctx);
			expect(imports.read).toHaveBeenCalledTimes(1);
			expect(getCommands).toHaveBeenCalledTimes(1);
			expect(imports.lsp).not.toHaveBeenCalled();

			const partial = await executeTool(registered, "read", { path: "a.ts", start_line: 1, end_line: 1 }, ctx);
			expect(imports.read).toHaveBeenCalledTimes(1);
			expect(getCommands).toHaveBeenCalledTimes(1);
			expect(imports.lsp).toHaveBeenCalledTimes(1);
			expect(enhanceRead).toHaveBeenCalledTimes(1);
			expect(partial.details).toMatchObject({ lsp: { enclosing_symbol: { name: "value" } } });

			await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
			expect(reload).toHaveBeenCalledTimes(1);
			await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
			expect(reload).toHaveBeenCalledTimes(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

function diagnostics(status: "clean" | "warnings" | "errors", message: string) {
	const severity = status === "errors" ? "error" as const : "warning" as const;
	return {
		status,
		file_errors: status === "errors" ? 1 : 0,
		file_warnings: status === "warnings" ? 1 : 0,
		new_errors: status === "errors" ? 1 : 0,
		new_warnings: status === "warnings" ? 1 : 0,
		resolved_errors: 0,
		resolved_warnings: 0,
		baseline: "unknown" as const,
		total_items: status === "clean" ? 0 : 1,
		items: status === "clean" ? [] : [{ severity, line: 1, column: 1, message }],
	};
}

function assistantToolMessage(calls: readonly { id: string; name: string }[]) {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
	};
}

async function announceMutationBatch(
	handlers: ReadonlyMap<string, LifecycleHandler>,
	calls: readonly { id: string; name: string }[],
): Promise<void> {
	await Promise.resolve(handlers.get("message_end")?.({ message: assistantToolMessage(calls) }));
	for (const call of calls) {
		await Promise.resolve(handlers.get("tool_execution_start")?.({ toolCallId: call.id, toolName: call.name, args: {} }));
	}
}

async function endMutationBatch(handlers: ReadonlyMap<string, LifecycleHandler>, ids: readonly string[]): Promise<void> {
	for (const id of ids) {
		await Promise.resolve(handlers.get("tool_execution_end")?.({ toolCallId: id, toolName: "write", result: {}, isError: false }));
	}
}
