import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import fileTools, { createFileToolsExtension, type FileToolsModuleImports } from "../../agent/extensions/file-tools.js";
import { lspFileHooks, lspManager } from "../../src/lsp/index.js";

interface ThemeStub {
	fg(name: string, text: string): string;
	bg(name: string, text: string): string;
	bold(text: string): string;
}

const theme: ThemeStub = {
	fg(_name: string, text: string) {
		return text;
	},
	bg(name: string, text: string) {
		return `<${name}>${text}</${name}>`;
	},
	bold(text: string) {
		return text;
	},
};

interface Renderable {
	render(width: number): string[];
}

type LifecycleHandler = (...args: unknown[]) => unknown;
type RenderResult = (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: ThemeStub, context: unknown) => Renderable;
type RenderCall = (args: unknown, theme: ThemeStub, context: unknown) => Renderable;
type ExecuteResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown };
type ExecuteTool = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: { cwd: string; sessionManager: { getSessionId(): string } },
) => Promise<ExecuteResult>;

describe("file-tools extension", () => {
	beforeAll(() => {
		initTheme();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("文件工具失败结果标记为错误，并按失败分支渲染", async () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				const index = registered.findIndex((item) => item.name === tool.name);
				if (index === -1) registered.push(tool);
				else registered[index] = tool;
			},
			on(name: string, handler: LifecycleHandler) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));

		const failure = {
			status: "failed" as const,
			error: { code: "INVALID_PATH", message: "path must be workspace-relative.", path: "C:/Users/orion/.pi" },
		};
		expect(handlers.get("tool_result")?.({ toolName: "find", details: failure })).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({ toolName: "find", details: { total: 0 } })).toBeUndefined();
		expect(handlers.get("tool_result")?.({
			toolName: "find",
			details: { status: "success", paths: ["src"], scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "Directory does not exist." } }] },
		})).toBeUndefined();

		for (const toolName of ["ls", "find", "grep", "read"]) {
			const output = renderToolResult(registered, toolName, failure);
			expect(output.split("\n")).toHaveLength(2);
			expect(output).toContain("INVALID_PATH: path must be workspace-relative.");
			expect(output).not.toContain('"status": "failed"');
		}

		const expanded = renderToolResult(registered, "find", {
			status: "failed" as const,
			error: {
				code: "READ_REQUIRED",
				message: "File changed since last read.",
				path: "src/app.ts",
				next: "Read the file again, then create a new edit operation.",
				details: { version: "new" },
			},
		}, true, { query: "app", path: "src" });
		expect(expanded.split("\n").length).toBeGreaterThan(2);
		expect(expanded).toContain('Call {"query":"app","path":"src"}');
		expect(expanded).toContain("Error READ_REQUIRED");
		expect(expanded).toContain("Path src/app.ts");
		expect(expanded).toContain("Next Read the file again, then create a new edit operation.");
		expect(expanded).toContain('Details {"version":"new"}');
		expect(expanded).not.toContain('"status": "failed"');
	});

	it("RPC 保留文件工具但不加载 native renderer", async () => {
		const registered: Array<{ name: string; renderCall?: unknown; renderResult?: unknown }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const loadRenderers = vi.fn(async () => {
			throw new Error("renderer must not load");
		});
		const extension = createFileToolsExtension({
			ls: () => import("../../src/file-tools/pi/adapters/ls.js"),
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

	it("grep 部分执行在 renderer 中保持 running，而不是误报失败", async () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));
		const grep = registered.slice().reverse().find((tool) => tool.name === "grep");
		const component = grep?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{ args: { query: "auth", path: ["src", "tests"] }, cwd: "/repo", lastComponent: undefined },
		);
		const output = component?.render(120).join("\n") ?? "";
		expect(output).toContain("grep");
		expect(output).toContain("searching files");
		expect(output).not.toContain("error");
	});

	it("find UI details 独立展示 Repo Map 关联文件和语义声明", async () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));
		const details = {
			query: "main",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 1,
			returnedMatches: 1,
			scannedEntries: 4,
			matches: [{ path: "src/main.ts", kind: "file" }],
			collapsedGroups: [],
			ignoredCount: 0,
			skippedCount: 0,
			scanTruncated: false,
			resultLimited: false,
			outputTruncated: false,
			related: [{
				path: "tests/main.test.ts",
				kind: "file",
				source: "repo-map",
				relations: ["test"],
				query_match: "not_guaranteed",
			}],
		};

		expect(renderToolResult(registered, "find", details)).toContain("1 related");
		const expanded = renderToolResult(registered, "find", details, true);
		expect(expanded).toContain("Related (repo-map; query match not guaranteed):");
		expect(expanded).toContain("tests/main.test.ts [test]");
	});

	it("注册阶段零预热，首次执行按工具加载，并发复用且失败可重试", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		const disposeFileToolsCaches = vi.fn();
		let resolveLs: ((module: typeof import("../../src/file-tools/pi/adapters/ls.js")) => void) | undefined;
		const pendingLs = new Promise<typeof import("../../src/file-tools/pi/adapters/ls.js")>((resolve) => {
			resolveLs = resolve;
		});
		let findLoadAttempts = 0;
		const imports = {
			ls: vi.fn(() => pendingLs),
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
		resolveLs({ ...(await import("../../src/file-tools/pi/adapters/ls.js")), disposeFileToolsCaches });
		await expect(firstLs).resolves.toMatchObject({ details: { path: "." } });
		await expect(secondLs).resolves.toMatchObject({ details: { path: "." } });
		expect(imports.ls).toHaveBeenCalledTimes(1);

		await expect(executeTool(registered, "find", { query: "package.json", path: ["."] }, ctx)).rejects.toThrow("simulated import failure");
		await expect(executeTool(registered, "find", { query: "package.json", path: ["."] }, ctx)).resolves.toMatchObject({
			details: { query: "package.json" },
		});
		expect(imports.find).toHaveBeenCalledTimes(2);
		expect(imports.repoMap).not.toHaveBeenCalled();
		await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, {}))).resolves.toBeUndefined();
		expect(imports.lsp).not.toHaveBeenCalled();
		expect(disposeFileToolsCaches).toHaveBeenCalledTimes(1);
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
			await executeTool(registered, "write", { path: "three.ts", content: "three\n" }, ctx);
			expect(createRepoMapFileToolQuery).toHaveBeenCalledTimes(2);
			expect(loadRepoMapOutputConfig).toHaveBeenCalledTimes(2);
		} finally {
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
			find: () => import("../../src/file-tools/pi/adapters/find.js"),
			grep: () => import("../../src/file-tools/pi/adapters/grep.js"),
			read: vi.fn(() => import("../../src/file-tools/pi/adapters/read.js")),
			write: () => import("../../src/file-tools/pi/adapters/write.js"),
			edit: () => import("../../src/file-tools/pi/adapters/edit.js"),
			lsp: vi.fn(async () => ({ ...(await import("../../src/lsp/index.js")), lspFileHooks: { enhanceRead } })),
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

	it("ls 失败结果渲染失败路径，而不是 workspace cwd", async () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));

		const ls = registered.slice().reverse().find((tool) => tool.name === "ls");
		const failure = {
			status: "failed" as const,
			error: {
				code: "PATH_NOT_FOUND",
				message: "Directory does not exist.",
				path: "homerail_manager/src/manager-agent",
			},
		};
		const component = ls?.renderResult?.(
			{ content: [{ type: "text", text: "<error/>" }], details: failure },
			{ expanded: false, isPartial: false },
			theme,
			{
				args: { path: "/home/orion/repo/homerail/homerail_manager/src/manager-agent" },
				cwd: "/home/orion/repo/homerail",
				lastComponent: undefined,
			},
		);

		const output = component?.render(120).join("\n") ?? "";
		expect(output).toContain("ls        homerail_manager/src/manager-agent");
		expect(output).toContain("PATH_NOT_FOUND: Directory does not exist.");
		expect(output).not.toContain("ls        /home/orion/repo/homerail");
	});

	it("find 使用自定义调用和结果 renderer 展示 strategy、类型、折叠组和扫描统计", async () => {
		const registered: Array<{ name: string; renderCall?: RenderCall; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));
		const find = registered.slice().reverse().find((tool) => tool.name === "find");
		const call = find?.renderCall?.({ query: "auth service", path: "." }, theme, {
			cwd: "/repo",
			lastComponent: undefined,
		});
		const callOutput = call?.render(120).join("\n") ?? "";
		expect(callOutput.split("\n")).toHaveLength(2);
		expect(callOutput).toContain('find      "auth service" in .');

		const details = {
			query: "auth service",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 5,
			returnedMatches: 3,
			scannedEntries: 42,
			matches: [
				{ path: "src/auth", kind: "directory" },
				{ path: "src/auth/service.ts", kind: "file" },
			],
			collapsedGroups: [{ path: "tests/auth", files: 2, directories: 0 }],
			ignoredCount: 1,
			skippedCount: 0,
			scanTruncated: true,
			resultLimited: true,
			outputTruncated: false,
		};
		const collapsed = find?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false },
			theme,
			{ lastComponent: undefined },
		);
		const collapsedOutput = collapsed?.render(120).join("\n") ?? "";
		expect(collapsedOutput.split("\n")).toHaveLength(2);
		expect(collapsedOutput).toContain("5 matches · 1 file · 1 directory · fuzzy · scan truncated · results limited");

		const expanded = find?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: undefined },
		);
		const output = expanded?.render(120).join("\n") ?? "";
		expect(output).toContain("src/auth/ (directory)");
		expect(output).toContain("src/auth/service.ts (file)");
		expect(output).toContain("tests/auth/** (2 files)");
		expect(output).toContain("Scanned 42 entries; skipped 0; ignored 1.");
		expect(output).toContain("Scan truncated.");
		expect(output).toContain("Results limited.");

		const nearbyDetails = {
			query: "auth servce",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 0,
			returnedMatches: 0,
			scannedEntries: 12,
			matches: [],
			collapsedGroups: [],
			ignoredCount: 0,
			skippedCount: 0,
			scanTruncated: false,
			resultLimited: false,
			outputTruncated: false,
			nearby: [{ path: "src/auth/service.ts", kind: "file", reason: "name similarity" }],
		};
		const nearby = find?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details: nearbyDetails },
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: undefined },
		);
		const nearbyOutput = nearby?.render(120).join("\n") ?? "";
		expect(nearbyOutput).toContain("0 matches · 0 files · 0 directories · fuzzy · 1 nearby");
		expect(nearbyOutput).toContain("Nearby (query match not guaranteed):");
		expect(nearbyOutput).toContain("src/auth/service.ts [name similarity]");
	});

	it("edit 完成后保留 tool card 背景，折叠态只显示两行摘要，展开后显示 diff", async () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));

		const success = renderEditResult(registered, {
			status: "applied",
			path: "src/app.ts",
			replacements: 1,
			old_version: "old",
			new_version: "new",
			diff: "-old\n+new",
		});
		expect(success).toContain("toolSuccessBg");
		expect(success).toContain("edit      src/app.ts");
		expect(success).toContain("+1 -1");
		expect(success).not.toContain("-old");
		expect(success).not.toContain("+new");

		const expandedSuccess = renderEditResult(registered, {
			status: "applied",
			path: "src/app.ts",
			replacements: 1,
			old_version: "old",
			new_version: "new",
			diff: "-old\n+new",
		}, true);
		expect(expandedSuccess).toContain("-old");
		expect(expandedSuccess).toContain("+new");

		const failure = renderEditResult(registered, {
			status: "failed",
			error: { code: "OLD_TEXT_NOT_FOUND", message: "edits[0].old was not found in the original file.", edit_index: 0 },
		});
		expect(failure).toContain("toolErrorBg");
		expect(failure).toContain("OLD_TEXT_NOT_FOUND: edits[0].old was not found in the original file.");

		const expandedFailure = renderEditResult(registered, {
			status: "failed",
			error: { code: "OLD_TEXT_NOT_FOUND", message: "edits[0].old was not found in the original file.", edit_index: 0 },
		}, true);
		expect(expandedFailure).toContain('Call {"path":"src/app.ts","edits":[{"old":"old","new":"new"}]}');
		expect(expandedFailure).toContain("Edit 0");
	});

	it("write 调用和结果的折叠态只显示两行摘要，展开后显示正文和 diff", async () => {
		const registered: Array<{ name: string; renderCall?: RenderCall; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));
		const write = registered.slice().reverse().find((tool) => tool.name === "write");
		const args = { path: "notes.txt", content: "first\nsecond" };
		const collapsedCall = write?.renderCall?.(args, theme, {
			argsComplete: true,
			cwd: "/repo",
			expanded: false,
			isPartial: true,
			lastComponent: undefined,
		});
		const collapsedCallOutput = collapsedCall?.render(120).join("\n") ?? "";
		expect(collapsedCallOutput.split("\n")).toHaveLength(2);
		expect(collapsedCallOutput).not.toContain("first");
		expect(collapsedCallOutput).not.toContain("second");

		const expandedCall = write?.renderCall?.(args, theme, {
			argsComplete: true,
			cwd: "/repo",
			expanded: true,
			isPartial: true,
			lastComponent: collapsedCall,
		});
		const expandedCallOutput = expandedCall?.render(120).join("\n") ?? "";
		expect(expandedCallOutput).toContain("first");
		expect(expandedCallOutput).toContain("second");

		const output = renderWriteResult(registered, {
			status: "written",
			path: "src/app.ts",
			bytes: 4,
			diff: "-1 old\n+1 new",
		});
		expect(output).toContain("write     src/app.ts");
		expect(output).toContain("+1 -1");
		expect(output.split("\n")).toHaveLength(2);
		expect(output).not.toContain("-1 old");
		expect(output).not.toContain("+1 new");

		const expanded = renderWriteResult(registered, {
			status: "written",
			path: "src/app.ts",
			bytes: 4,
			diff: "-1 old\n+1 new",
		}, true);
		expect(expanded).toContain("-1 old");
		expect(expanded).toContain("+1 new");
	});

	it("edit 参数完整后的折叠调用只显示摘要，展开后显示预览 diff", async () => {
		const registered: Array<{ name: string; renderCall?: RenderCall }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-edit-card-"));
		await writeFile(join(cwd, "app.ts"), "old\n", "utf8");
		const edit = registered.slice().reverse().find((tool) => tool.name === "edit");
		const args = { path: "app.ts", edits: [{ old: "old", new: "new" }] };
		const context = {
			args,
			argsComplete: true,
			cwd,
			expanded: false,
			invalidate: vi.fn(),
			isPartial: true,
			lastComponent: undefined,
			state: {},
		};

		const first = edit?.renderCall?.(args, theme, context);
		await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalled());
		const collapsed = edit?.renderCall?.(args, theme, { ...context, lastComponent: first });
		const output = collapsed?.render(120).join("\n") ?? "";
		expect(output).toContain("edit      app.ts");
		expect(output).not.toContain("-1 old");
		expect(output).not.toContain("+1 new");

		const expanded = edit?.renderCall?.(args, theme, { ...context, expanded: true, lastComponent: first });
		const expandedOutput = expanded?.render(120).join("\n") ?? "";
		expect(expandedOutput).toContain("-1 old");
		expect(expandedOutput).toContain("+1 new");
	});

	it("read/edit 成功结果给模型返回紧凑文本，完整结构留在 details", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		fileTools({
			registerTool(tool: { name: string; execute?: ExecuteTool }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-compact-file-output-"));
		const originalAfterEdit = lspFileHooks.afterEdit;
		try {
			delete lspFileHooks.afterEdit;
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf8");
			const ctx = { cwd, sessionManager: { getSessionId: () => "session-1" } };
			const read = await executeTool(registered, "read", { path: "a.ts" }, ctx);
			const readText = textResult(read);
			expect(readText).toBe('<read path="a.ts" lines="1-2/2">\none\ntwo\n</read>');
			expect(readText).not.toContain('"encoding"');
			expect(read.details).toMatchObject({ path: "a.ts", content: "one\ntwo\n", encoding: "utf-8", bom: false });

			const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
			await writeFile(join(cwd, "pixel.gif"), imageBytes);
			const imageRead = await executeTool(registered, "read", { path: "pixel.gif" }, ctx);
			expect(imageRead.content).toEqual([
				{ type: "text", text: "Read image file [image/gif]" },
				{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/gif" },
			]);
			expect(imageRead.details).toMatchObject({ path: "pixel.gif", media_type: "image", image: { mime_type: "image/gif" } });

			const edit = await executeTool(registered, "edit", { path: "a.ts", edits: [{ old: "two", new: "TWO" }] }, ctx);
			const editText = textResult(edit);
			expect(editText).toBe('<edit path="a.ts" replacements="1" first_changed_line="2"/>');
			expect(editText).not.toContain('"diff"');
			expect(edit.details).toMatchObject({ status: "applied", path: "a.ts", replacements: 1, diff: expect.stringContaining("+2 TWO") });

			const failedRead = await executeTool(registered, "read", { path: "missing.ts" }, ctx);
			expect(textResult(failedRead)).toContain('<error tool="read" code="FILE_NOT_FOUND">');
		} finally {
			if (originalAfterEdit === undefined) delete lspFileHooks.afterEdit;
			else lspFileHooks.afterEdit = originalAfterEdit;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("write 成功结果返回紧凑 XML 和有限 LSP 诊断", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		fileTools({
			registerTool(tool: { name: string; execute?: ExecuteTool }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-compact-write-output-"));
		const originalAfterWrite = lspFileHooks.afterWrite;
		try {
			const ctx = { cwd, sessionManager: { getSessionId: () => "session-1" } };
			delete lspFileHooks.afterWrite;
			const clean = await executeTool(registered, "write", { path: "clean.ts", content: "export const ok = true;\n" }, ctx);
			expect(textResult(clean)).toBe('<write path="clean.ts"/>');
			expect(clean.details).toMatchObject({ status: "written", path: "clean.ts", diff: expect.stringContaining("+1 export const ok = true;") });

			for (const status of ["timeout", "unavailable"] as const) {
				lspFileHooks.afterWrite = vi.fn(async () => ({
					status,
					file_errors: 0,
					file_warnings: 0,
					new_errors: 0,
					new_warnings: 0,
					resolved_errors: 0,
					resolved_warnings: 0,
					baseline: "unknown" as const,
					total_items: 0,
					items: [],
				}));
				const result = await executeTool(registered, "write", { path: `${status}.ts`, content: "content\n" }, ctx);
				expect(textResult(result)).toBe(`<write path="${status}.ts"/>`);
			}

			lspFileHooks.afterWrite = vi.fn(async () => ({
				status: "errors" as const,
				file_errors: 2,
				file_warnings: 4,
				new_errors: 1,
				new_warnings: 0,
				resolved_errors: 0,
				resolved_warnings: 0,
				baseline: "known" as const,
				total_items: 8,
				items: [
					{ severity: "error" as const, line: 12, column: 5, message: "Cannot find name 'foo'.", code: "TS2304" },
					{ severity: "warning" as const, line: 30, column: 7, message: "'bar' is declared but never used." },
					{ severity: "warning" as const, line: 31, column: 7, message: "unused 2" },
					{ severity: "warning" as const, line: 32, column: 7, message: "unused 3" },
					{ severity: "warning" as const, line: 33, column: 7, message: "unused 4" },
					{ severity: "error" as const, line: 40, column: 1, message: "hidden" },
				],
			}));
			const errored = await executeTool(registered, "write", { path: "bad.ts", content: "foo\n" }, ctx);
			expect(textResult(errored)).toBe([
				'<write path="bad.ts" lsp="errors">',
				"errors=2 warnings=4 new_errors=1 new_warnings=0",
				"diag error 12:5 Cannot find name 'foo'. (TS2304)",
				"diag warning 30:7 'bar' is declared but never used.",
				"diag warning 31:7 unused 2",
				"diag warning 32:7 unused 3",
				"diag warning 33:7 unused 4",
				"diag error 40:1 hidden",
				"... 2 more diagnostics",
				"</write>",
			].join("\n"));
			expect(errored.details).toMatchObject({ status: "written", diff: expect.stringContaining("+1 foo"), lsp: { diagnostics: { status: "errors", items: expect.any(Array) } } });
		} finally {
			if (originalAfterWrite === undefined) delete lspFileHooks.afterWrite;
			else lspFileHooks.afterWrite = originalAfterWrite;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("edit 成功结果返回紧凑 XML 和有限 LSP 诊断", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		fileTools({
			registerTool(tool: { name: string; execute?: ExecuteTool }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-compact-edit-output-"));
		const originalAfterEdit = lspFileHooks.afterEdit;
		try {
			await writeFile(join(cwd, "bad.ts"), "foo\n", "utf8");
			lspFileHooks.afterEdit = vi.fn(async () => ({
				status: "errors" as const,
				file_errors: 2,
				file_warnings: 4,
				new_errors: 1,
				new_warnings: 0,
				resolved_errors: 0,
				resolved_warnings: 0,
				baseline: "known" as const,
				total_items: 8,
				items: [
					{ severity: "error" as const, line: 12, column: 5, message: "Cannot find name 'foo'.", code: "TS2304" },
					{ severity: "warning" as const, line: 30, column: 7, message: "'bar' is declared but never used." },
					{ severity: "warning" as const, line: 31, column: 7, message: "unused 2" },
					{ severity: "warning" as const, line: 32, column: 7, message: "unused 3" },
					{ severity: "warning" as const, line: 33, column: 7, message: "unused 4" },
					{ severity: "error" as const, line: 40, column: 1, message: "hidden" },
				],
			}));
			const ctx = { cwd, sessionManager: { getSessionId: () => "session-1" } };
			await executeTool(registered, "read", { path: "bad.ts" }, ctx);
			const edited = await executeTool(registered, "edit", { path: "bad.ts", edits: [{ old: "foo", new: "bar" }] }, ctx);
			expect(textResult(edited)).toBe([
				'<edit path="bad.ts" replacements="1" first_changed_line="1" lsp="errors">',
				"errors=2 warnings=4 new_errors=1 new_warnings=0",
				"diag error 12:5 Cannot find name 'foo'. (TS2304)",
				"diag warning 30:7 'bar' is declared but never used.",
				"diag warning 31:7 unused 2",
				"diag warning 32:7 unused 3",
				"diag warning 33:7 unused 4",
				"diag error 40:1 hidden",
				"... 2 more diagnostics",
				"</edit>",
			].join("\n"));
			expect(edited.details).toMatchObject({ status: "applied", path: "bad.ts", lsp: { diagnostics: { status: "errors", items: expect.any(Array) } } });
		} finally {
			if (originalAfterEdit === undefined) delete lspFileHooks.afterEdit;
			else lspFileHooks.afterEdit = originalAfterEdit;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("文件工具失败结果给模型返回紧凑 error tag", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		fileTools({
			registerTool(tool: { name: string; execute?: ExecuteTool }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-compact-error-output-"));
		try {
			await writeFile(join(cwd, "a.ts"), "const one = 1;\n", "utf8");
			const ctx = { cwd, sessionManager: { getSessionId: () => "session-1" } };
			for (const [tool, params] of [
				["ls", { path: "missing" }],
				["find", { query: "" }],
				["grep", { query: "[", match: "regex" }],
				["read", { path: "missing.ts" }],
				["write", { path: ".git/config", content: "x" }],
				["edit", { path: "a.ts", edits: [{ old: "one", new: "two" }] }],
			] as const) {
				const result = await executeTool(registered, tool, params, ctx);
				const text = textResult(result);
				expect(text).toMatch(new RegExp(`^<error tool="${tool}" code="[A-Z_]+">\\n[^]+\\n</error>$`));
				expect(text).not.toContain("\n  ");
				expect(result.details).toMatchObject({ status: "failed" });
				if (tool === "edit") expect(text).toContain("next: Read the file, then create a new edit operation.");
			}

			const grep = await executeTool(registered, "grep", { query: "one" }, ctx);
			expect(textResult(grep)).toContain("a.ts");
			expect(textResult(grep)).not.toContain("<error");
			expect(textResult(grep)).not.toContain('"status"');

			const partialFind = await executeTool(registered, "find", { query: "a.ts", path: [".", "missing"] }, ctx);
			expect(textResult(partialFind)).toContain("partial; scope_errors=missing:PATH_NOT_FOUND");
			expect(partialFind.details).toMatchObject({ paths: ["."], scope_errors: [{ path: "missing" }] });

			const partialGrep = await executeTool(registered, "grep", { query: "one", path: [".", "missing"] }, ctx);
			expect(textResult(partialGrep)).toContain("partial; scope_errors=missing:PATH_NOT_FOUND");
			expect(partialGrep.details).toMatchObject({ paths: ["."], scope_errors: [{ path: "missing" }] });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

async function activateFileTools(handler: LifecycleHandler | undefined, mode: "tui" | "rpc" = "tui"): Promise<void> {
	await handler?.({}, { mode, ui: { notify() {} } });
}

function renderToolResult(registered: Array<{ name: string; renderResult?: RenderResult }>, toolName: string, details: unknown, expanded = false, args?: unknown): string {
	const tool = registered.slice().reverse().find((item) => item.name === toolName);
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded, isPartial: false },
		theme,
		{ args, cwd: "C:/Users/orion/.pi" },
	);
	return component?.render(120).join("\n") ?? "";
}

function renderEditResult(registered: Array<{ name: string; renderResult?: RenderResult }>, details: unknown, expanded = false): string {
	const tool = registered.slice().reverse().find((item) => item.name === "edit");
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded, isPartial: false },
		theme,
		{
			args: { path: "src/app.ts", edits: [{ old: "old", new: "new" }] },
			cwd: "/repo",
			expanded,
			lastComponent: undefined,
			state: {},
		},
	);
	return component?.render(120).join("\n") ?? "";
}

function renderWriteResult(registered: Array<{ name: string; renderResult?: RenderResult }>, details: unknown, expanded = false): string {
	const tool = registered.slice().reverse().find((item) => item.name === "write");
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded, isPartial: false },
		theme,
		{
			args: { path: "src/app.ts", content: "new" },
			cwd: "/repo",
			lastComponent: undefined,
		},
	);
	return component?.render(120).join("\n") ?? "";
}

async function executeTool(
	registered: Array<{ name: string; execute?: ExecuteTool }>,
	name: string,
	params: unknown,
	ctx: { cwd: string; sessionManager: { getSessionId(): string } },
): Promise<ExecuteResult> {
	const tool = registered.find((item) => item.name === name);
	if (tool?.execute === undefined) throw new Error(`${name} execute not registered`);
	return tool.execute(`${name}-1`, params, undefined, undefined, ctx);
}

function textResult(result: ExecuteResult): string {
	return result.content
		.filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}
