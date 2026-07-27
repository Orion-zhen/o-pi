import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { useTempDir } from "../helpers/lifecycle.js";
import {
	activateFileTools,
	renderEditResult,
	renderToolResult,
	renderWriteResult,
	theme,
	type LifecycleHandler,
	type RenderCall,
	type RenderResult,
} from "./extension-fixture.js";

const editCardTemp = useTempDir("o-pi-edit-card-");

describe("file-tools extension renderers", () => {
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
			matches: [{ path: "src/main.ts", kind: "file" }],
			collapsedGroups: [],
			ignoredCount: 0,
			skippedCount: 0,
			depthLimited: false,
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
		const cwd = join(process.cwd(), "homerail");
		const requestedPath = join(cwd, "homerail_manager", "src", "manager-agent");
		const component = ls?.renderResult?.(
			{ content: [{ type: "text", text: "<error/>" }], details: failure },
			{ expanded: false, isPartial: false },
			theme,
			{
				args: { path: requestedPath },
				cwd,
				lastComponent: undefined,
			},
		);

		const output = component?.render(120).join("\n") ?? "";
		expect(output).toContain("ls        homerail_manager/src/manager-agent");
		expect(output).toContain("PATH_NOT_FOUND: Directory does not exist.");
		expect(output).not.toContain(`ls        ${cwd}`);
	});

	it("find 使用自定义调用和结果 renderer 展示 strategy、类型、折叠组和跳过统计", async () => {
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
			matches: [
				{ path: "src/auth", kind: "directory" },
				{ path: "src/auth/service.ts", kind: "file" },
			],
			collapsedGroups: [{ path: "tests/auth", files: 2, directories: 0 }],
			ignoredCount: 1,
			skippedCount: 0,
			depthLimited: true,
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
		expect(collapsedOutput).toContain("5 matches · 1 file · 1 directory · fuzzy · depth limited · results limited");

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
		expect(output).toContain("Skipped 0; ignored 1.");
		expect(output).toContain("Depth limited.");
		expect(output).toContain("Results limited.");

		const nearbyDetails = {
			query: "auth servce",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 0,
			returnedMatches: 0,
			matches: [],
			collapsedGroups: [],
			ignoredCount: 0,
			skippedCount: 0,
			depthLimited: false,
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
		expect(success).toContain("LSP unavailable");
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
		const state: { callComponent?: { phase?: unknown; postProcess?: unknown } } = {};
		const collapsedCall = write?.renderCall?.(args, theme, {
			argsComplete: true,
			cwd: "/repo",
			expanded: false,
			isPartial: true,
			lastComponent: undefined,
			state,
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
			state,
		});
		const expandedCallOutput = expandedCall?.render(120).join("\n") ?? "";
		expect(expandedCallOutput).toContain("first");
		expect(expandedCallOutput).toContain("second");

		const partialResult = write?.renderResult?.(
			{
				content: [],
				details: {
					status: "post-processing",
					diff: "-1 old\n+1 new",
					lsp: { status: "clean", errors: 0, warnings: 0 },
					repo_map: "running",
				},
			},
			{ expanded: false, isPartial: true },
			theme,
			{ args, cwd: "/repo", lastComponent: undefined, state },
		);
		expect(partialResult?.render(120)).toEqual([]);
		expect(state.callComponent?.postProcess).toMatchObject({ lsp: { status: "clean" }, repo_map: "running" });
		expect(collapsedCall?.render(120).join("\n")).toContain("LSP clean");
		expect(collapsedCall?.render(120).join("\n")).toContain("Repo Map updating");
		expect(collapsedCall?.render(120).join("\n")).toContain("+1 -1");

		const output = renderWriteResult(registered, {
			status: "written",
			path: "src/app.ts",
			bytes: 4,
			diff: "-1 old\n+1 new",
			lsp: { diagnostics: { status: "clean", file_errors: 0, file_warnings: 0 } },
		});
		expect(output).toContain("write     src/app.ts");
		expect(output).toContain("+1 -1");
		expect(output).toContain("LSP clean");
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
		const registered: Array<{ name: string; renderCall?: RenderCall; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);
		await activateFileTools(handlers.get("session_start"));

		const cwd = editCardTemp.path;
		await writeFile(join(cwd, "app.ts"), "old\n", "utf8");
		const edit = registered.slice().reverse().find((tool) => tool.name === "edit");
		const args = { path: "app.ts", edits: [{ old: "old", new: "new" }] };
		const state: { callComponent?: { phase?: unknown; postProcess?: unknown } } = {};
		const context = {
			args,
			argsComplete: true,
			cwd,
			expanded: false,
			invalidate: vi.fn(),
			isPartial: true,
			lastComponent: undefined,
			state,
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

		const partialResult = edit?.renderResult?.(
			{
				content: [],
				details: {
					status: "post-processing",
					diff: "-1 old\n+1 new",
					replacements: 1,
					lsp: { status: "errors", errors: 2, warnings: 1 },
					repo_map: "inactive",
				},
			},
			{ expanded: false, isPartial: true },
			theme,
			{ args, cwd, expanded: false, lastComponent: undefined, state },
		);
		expect(partialResult?.render(120)).toEqual([]);
		expect(state.callComponent?.postProcess).toMatchObject({ lsp: { status: "errors", errors: 2 }, repo_map: "inactive" });
		expect(collapsed?.render(120).join("\n")).toContain("LSP 2 errors");
		expect(collapsed?.render(120).join("\n")).toContain("Repo Map inactive");
		expect(collapsed?.render(120).join("\n")).toContain("+1 -1");
	});
});
