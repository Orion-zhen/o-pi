import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { useTempDir } from "../helpers/lifecycle.js";
import {
	activateFileTools,
	renderToolResult,
	renderWriteResult,
	theme,
	type LifecycleHandler,
	type RenderCall,
	type RenderResult,
} from "./extension-fixture.js";

interface RegisteredRenderer {
	name: string;
	renderCall?: RenderCall;
	renderResult?: RenderResult;
}

const editCardTemp = useTempDir("o-pi-edit-card-");

describe("file-tools extension renderers", () => {
	beforeAll(() => initTheme());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("失败和部分结果保持正确状态且不丢失错误信息", async () => {
		const { registered, handlers } = await registerRenderers();
		const failure = {
			status: "failed" as const,
			error: { code: "INVALID_PATH", message: "path must be workspace-relative.", path: "src/missing" },
		};

		expect(handlers.get("tool_result")?.({ toolName: "find", details: failure })).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({ toolName: "find", details: { status: "success" } })).toBeUndefined();
		for (const toolName of ["ls", "find", "grep", "read"]) {
			const output = renderToolResult(registered, toolName, failure, true);
			expect(output).toContain("INVALID_PATH");
			expect(output).toContain("src/missing");
		}

		const grep = registered.slice().reverse().find((tool) => tool.name === "grep");
		const partial = grep?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{ args: { query: "auth", path: ["src"] }, cwd: "/repo", lastComponent: undefined },
		)?.render(80).join("\n") ?? "";
		expect(partial.length).toBeGreaterThan(0);
		expect(partial).not.toContain("error");
	});

	it("find 展开结果保留匹配、关联文件和部分 scope 错误", async () => {
		const { registered } = await registerRenderers();
		const output = renderToolResult(registered, "find", {
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
			scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "missing" } }],
		}, true);

		for (const value of ["src/main.ts", "tests/main.test.ts", "missing", "PATH_NOT_FOUND"]) {
			expect(output).toContain(value);
		}
	});

	it("write 折叠时隐藏正文和 diff，展开时恢复，并接收后处理进度", async () => {
		const { registered } = await registerRenderers();
		const write = registered.slice().reverse().find((tool) => tool.name === "write");
		const args = { path: "notes.txt", content: "first\nsecond" };
		const state: { callComponent?: { postProcess?: unknown } } = {};
		const context = { argsComplete: true, cwd: "/repo", isPartial: true, lastComponent: undefined, state };
		const collapsed = write?.renderCall?.(args, theme, { ...context, expanded: false });
		const collapsedOutput = collapsed?.render(80).join("\n");
		const expanded = write?.renderCall?.(args, theme, { ...context, expanded: true, lastComponent: collapsed });
		expect(collapsedOutput).not.toContain("first");
		expect(expanded?.render(80).join("\n")).toContain("first");

		const progress = write?.renderResult?.(
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
		expect(progress?.render(80)).toEqual([]);
		expect(state.callComponent?.postProcess).toMatchObject({ lsp: { status: "clean" }, repo_map: "running" });

		const result = {
			status: "written",
			path: "src/app.ts",
			bytes: 4,
			diff: "-1 old\n+1 new",
		};
		expect(renderWriteResult(registered, result)).not.toContain("-1 old");
		expect(renderWriteResult(registered, result, true)).toContain("-1 old");
	});

	it("edit 预览异步刷新，折叠时隐藏 diff，展开时恢复", async () => {
		const { registered } = await registerRenderers();
		const cwd = editCardTemp.path;
		await writeFile(join(cwd, "app.ts"), "old\n", "utf8");
		const edit = registered.slice().reverse().find((tool) => tool.name === "edit");
		const args = { path: "app.ts", edits: [{ old: "old", new: "new" }] };
		const state: { callComponent?: { postProcess?: unknown } } = {};
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
		const collapsedOutput = collapsed?.render(80).join("\n");
		const expanded = edit?.renderCall?.(args, theme, { ...context, expanded: true, lastComponent: first });
		expect(collapsedOutput).not.toContain("-1 old");
		expect(expanded?.render(80).join("\n")).toContain("-1 old");

		const progress = edit?.renderResult?.(
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
		expect(progress?.render(80)).toEqual([]);
		expect(state.callComponent?.postProcess).toMatchObject({ lsp: { status: "errors", errors: 2 }, repo_map: "inactive" });
	});
});

async function registerRenderers(): Promise<{
	registered: RegisteredRenderer[];
	handlers: Map<string, LifecycleHandler>;
}> {
	const registered: RegisteredRenderer[] = [];
	const handlers = new Map<string, LifecycleHandler>();
	fileTools({
		registerTool(tool: RegisteredRenderer) { registered.push(tool); },
		on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI);
	await activateFileTools(handlers.get("session_start"));
	return { registered, handlers };
}
