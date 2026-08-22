import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { activateFileTools, registerExtension, renderToolResult, renderWriteResult, theme } from "./extension-fixture.js";

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
			const output = renderToolResult(registered, toolName, failure, { expanded: true });
			for (const value of ["INVALID_PATH", "src/missing"]) expect(output).toContain(value);
		}

		const partial = renderToolResult(registered, "grep", undefined, {
			isPartial: true,
			content: [{ type: "text", text: "" }],
			width: 80,
			context: { args: { query: "auth", path: ["src"] }, cwd: "/repo", lastComponent: undefined },
		});
		expect(partial.length).toBeGreaterThan(0);
		expect(partial).not.toContain("error");
	});

	it("find 展开结果保留匹配和部分 scope 错误", async () => {
		const { registered } = await registerRenderers();
		const output = renderToolResult(registered, "find", {
			status: "success",
			query: "main",
			path: ".",
			paths: ["."],
			total_candidates: 1,
			total_matches: 1,
			returned_matches: 1,
			matches: [{ path: "src/main.ts", kind: "file" }],
			displayed_matches: [{ path: "src/main.ts", kind: "file" }],
			stats: { traversed_entries: 1, ignored_entries: 0, skipped_entries: 0 },
			truncated_by: [],
			ranking: { algorithm: "fzf-v2-path-v1" },
			scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "missing" } }],
		}, { expanded: true });

		for (const value of ["src/main.ts", "missing", "PATH_NOT_FOUND"]) expect(output).toContain(value);
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

		const progress = renderToolResult(registered, "write", {
			status: "post-processing",
			diff: "-1 old\n+1 new",
			lsp: { status: "clean", errors: 0, warnings: 0 },
		}, {
			isPartial: true,
			content: [],
			width: 80,
			context: { args, cwd: "/repo", lastComponent: undefined, state },
		});
		expect(progress).toBe("");
		expect(state.callComponent?.postProcess).toMatchObject({ lsp: { status: "clean" } });

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
		const streamState: { callComponent?: { postProcess?: unknown } } = {};
		const partialArgs = { path: "app.ts", edits: [{ old: "old", new: "new line" }] };
		const partial = edit?.renderCall?.(partialArgs, theme, { ...context, args: partialArgs, argsComplete: false, lastComponent: undefined, state: streamState });
		const partialOutput = partial?.render(80).join("\n");
		expect(partialOutput).toContain("1 replacements");
		expect(partialOutput).toContain("2 lines");
		expect(partialOutput).toContain("11 chars");
		const largerArgs = { path: "app.ts", edits: [{ old: "old", new: "new line\nwith more output" }] };
		const larger = edit?.renderCall?.(largerArgs, theme, { ...context, args: largerArgs, argsComplete: false, lastComponent: partial, state: streamState });
		expect(larger?.render(80).join("\n")).toContain("28 chars");
		const collapsed = edit?.renderCall?.(args, theme, { ...context, lastComponent: first });
		const collapsedOutput = collapsed?.render(80).join("\n");
		const expanded = edit?.renderCall?.(args, theme, { ...context, expanded: true, lastComponent: first });
		expect(collapsedOutput).not.toContain("-1 old");
		expect(expanded?.render(80).join("\n")).toContain("-1 old");

		const progress = renderToolResult(registered, "edit", {
			status: "post-processing",
			diff: "-1 old\n+1 new",
			replacements: 1,
			lsp: { status: "errors", errors: 2, warnings: 1 },
		}, {
			isPartial: true,
			content: [],
			width: 80,
			context: { args, cwd, expanded: false, lastComponent: undefined, state },
		});
		expect(progress).toBe("");
		expect(state.callComponent?.postProcess).toMatchObject({ lsp: { status: "errors", errors: 2 } });

		const result = renderToolResult(registered, "edit", {
			status: "applied",
			path: "app.ts",
			replacements: 1,
			diff: "-1 old\n+1 new",
			lsp: { diagnostics: { status: "clean", file_errors: 0, file_warnings: 0, items: [] } },
		}, {
			isPartial: false,
			content: [],
			width: 80,
			context: { args, cwd, expanded: false, lastComponent: undefined, state },
		});
		expect(result).toContain("LSP clean");
	});
});

async function registerRenderers() {
	const extension = registerExtension(fileTools);
	await activateFileTools(extension.handlers.get("session_start"));
	return extension;
}
