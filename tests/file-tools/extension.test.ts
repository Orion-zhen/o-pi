import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileToolsExtension, type FileToolsModuleImports } from "../../agent/extensions/file-tools.js";
import { lspManager } from "../../src/lsp/index.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { activateFileTools, executeTool, type ExecuteResult, type ExecuteTool, type LifecycleHandler } from "./extension-fixture.js";

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
			repoMap: () => import("../../src/file-tools/pi/repo-map-runtime.js"),
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
			repoMap: vi.fn(() => import("../../src/file-tools/pi/repo-map-runtime.js")),
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
		expect(imports.repoMap).not.toHaveBeenCalled();

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
		expect(imports.repoMap).not.toHaveBeenCalled();
		await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
		expect(imports.lsp).not.toHaveBeenCalled();
		expect(imports.repoMap).not.toHaveBeenCalled();
		expect(imports.grep).not.toHaveBeenCalled();
		expect(imports.read).not.toHaveBeenCalled();
		expect(imports.write).not.toHaveBeenCalled();
		expect(imports.edit).not.toHaveBeenCalled();
		expect(disposeHost).toHaveBeenCalledTimes(1);
	});

	it("同一 session 复用 Repo Map runtime，shutdown 后释放", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const outputConfig = { read_context_token_budget: 640, mutation_impact_token_budget: 480 };
		const loadRepoMapOutputConfig = vi.fn(async () => outputConfig);
		const formatRepoMapImpact = vi.fn((_impact: unknown, config: typeof outputConfig = outputConfig) =>
			`<repo_impact>\nbudget="${config.mutation_impact_token_budget}"\n</repo_impact>`);
		const createRepoMapFileToolQuery = vi.fn(() => ({
			async query() { return undefined; },
			async readContext() { return undefined; },
			async syncMutation() {
				return {
					status: "updated" as const,
					generation: "2".repeat(64),
					impact: { candidate: true as const, changedPath: "one.ts", changedSymbols: [], publicApiChanges: [], candidates: [] },
				};
			},
		}));
		const imports = {
			ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
			host: () => import("../../src/file-tools/runtime/host.js"),
			find: () => import("../../src/file-tools/pi/adapters/find.js"),
			grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
			read: () => import("../../src/file-tools/pi/adapters/read.js"),
			write: () => import("../../src/file-tools/pi/adapters/write.js"),
			edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
			lsp: () => import("../../src/lsp/index.js"),
			async repoMap() {
				return {
					createRepoMapFileToolQuery,
					loadRepoMapOutputConfig,
					formatRepoMapImpact,
					formatRepoMapReadContext: () => undefined,
				};
			},
		} satisfies FileToolsModuleImports;
		createFileToolsExtension(imports)({
			registerTool(tool: { name: string; execute?: ExecuteTool }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
			appendEntry() {},
		} as unknown as ExtensionAPI);
		const cwd = await mkdtemp(join(tmpdir(), "o-pi-repo-map-session-"));
		const branch = [{
			type: "custom",
			customType: "o-pi:repo-map",
			data: {
				kind: "activation",
				root: cwd,
				mapId: "0".repeat(64),
				generation: "1".repeat(64),
				activatedAt: "2026-07-18T00:00:00.000Z",
			},
		}];
		const ctx = { cwd, sessionManager: { getSessionId: () => "repo-map-session", getBranch: () => branch } };
		try {
			const first = await executeTool(registered, "write", { path: "one.ts", content: "one\n" }, ctx);
			await executeTool(registered, "write", { path: "two.ts", content: "two\n" }, ctx);
			expect(first.content[0]?.text).toContain('budget="480"');
			expect(createRepoMapFileToolQuery).toHaveBeenCalledTimes(1);
			expect(loadRepoMapOutputConfig).toHaveBeenCalledTimes(1);
			expect(formatRepoMapImpact).toHaveBeenCalledWith(expect.anything(), outputConfig);
			await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
			const afterShutdown = await executeTool(registered, "write", { path: "three.ts", content: "three\n" }, ctx);
			expect(afterShutdown.details).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			expect(createRepoMapFileToolQuery).toHaveBeenCalledTimes(1);
			expect(loadRepoMapOutputConfig).toHaveBeenCalledTimes(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("mutation 提交后 LSP 与 Repo Map 增强失败或取消仍返回成功", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const controller = new AbortController();
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
					lspFileOperations: {
						async afterWrite() { throw new Error("lsp unavailable"); },
					},
				};
			},
			async repoMap() {
				return {
					createRepoMapFileToolQuery: () => ({
						async query() { return undefined; },
						async readContext() { return undefined; },
						async syncMutation() {
							controller.abort();
							throw new Error("repo map cancelled");
						},
					}),
					async loadRepoMapOutputConfig() {
						return { read_context_token_budget: 640, mutation_impact_token_budget: 480 };
					},
					formatRepoMapImpact: () => undefined,
					formatRepoMapReadContext: () => undefined,
				};
			},
		} satisfies FileToolsModuleImports;
		createFileToolsExtension(imports)({
			registerTool(tool: { name: string; execute?: ExecuteTool }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
			appendEntry() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-post-mutation-enhancement-"));
		const branch = [{
			type: "custom",
			customType: "o-pi:repo-map",
			data: {
				kind: "activation",
				root: cwd,
				mapId: "0".repeat(64),
				generation: "1".repeat(64),
				activatedAt: "2026-07-18T00:00:00.000Z",
			},
		}];
		const ctx = { cwd, sessionManager: { getSessionId: () => "post-mutation", getBranch: () => branch } };
		try {
			const updates: ExecuteResult[] = [];
			const result = await executeTool(
				registered,
				"write",
				{ path: "committed.ts", content: "committed\n" },
				ctx,
				controller.signal,
				(update) => updates.push(update),
			);
			expect(result.details).toMatchObject({ status: "written", path: "committed.ts" });
			expect(updates).toEqual(expect.arrayContaining([
				expect.objectContaining({
					details: expect.objectContaining({
						status: "post-processing",
						lsp: { status: "unavailable", errors: 0, warnings: 0 },
						repo_map: "unavailable",
					}),
				}),
			]));
			expect(await readFile(join(cwd, "committed.ts"), "utf8")).toBe("committed\n");
			expect(controller.signal.aborted).toBe(true);

			const edit = await executeTool(registered, "edit", {
				path: "committed.ts",
				edits: [{ old: "committed", new: "changed" }],
			}, ctx, controller.signal);
			expect(edit.details).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			expect(await readFile(join(cwd, "committed.ts"), "utf8")).toBe("committed\n");
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
			repoMap: vi.fn(() => import("../../src/file-tools/pi/repo-map-runtime.js")),
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
			expect(imports.repoMap).not.toHaveBeenCalled();

			await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
			expect(reload).toHaveBeenCalledTimes(1);
			await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
			expect(reload).toHaveBeenCalledTimes(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
