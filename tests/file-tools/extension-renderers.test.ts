import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { activateFileTools, registerExtension, renderToolResult, theme } from "./extension-fixture.js";

const editCardTemp = useTempDir("o-pi-edit-card-");

describe("file-tools extension renderers", () => {
	beforeAll(() => initTheme());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	rendererTest("失败和部分结果保持正确状态且不丢失错误信息", async ({ registered, handlers }) => {
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

	rendererTest("find 展开结果保留匹配和部分 scope 错误", async ({ registered }) => {
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

	rendererTest("read 调用显示 lines 或 pages，PDF 结果展示页面摘要且不泄露 Base64", async ({ registered }) => {
		const read = registered.slice().reverse().find((tool) => tool.name === "read");
		const callContext = {
			cwd: "/repo",
			isPartial: true,
			lastComponent: undefined,
		};
		const lineCall = read?.renderCall?.({ path: "src/app.ts", lines: "5-" }, theme, callContext);
		expect(lineCall?.render(80).join("\n")).toContain("lines 5-");
		const pageCall = read?.renderCall?.({ path: "docs/spec.pdf", pages: "2-3" }, theme, callContext);
		expect(pageCall?.render(80).join("\n")).toContain("pages 2-3");

		const details = {
			path: "docs/spec.pdf",
			media_type: "pdf",
			mime_type: "application/pdf",
			size_bytes: 2048,
			version: "version",
			start_page: 2,
			end_page: 3,
			total_pages: 10,
			truncated: true,
			continuation: { start_page: 4 },
			metadata: { title: "Private title", author: "Private author" },
			pages: [
				{
					number: 2,
					label: "ii",
					width_points: 300,
					height_points: 200,
					rotation: 0,
					image: { data: "secret-page-two-base64", mime_type: "image/png" },
					hints: ["[Image resized to 600x400.]"],
				},
				{
					number: 3,
					label: "3",
					width_points: 400,
					height_points: 300,
					rotation: 90,
					image: { data: "secret-page-three-base64", mime_type: "image/jpeg" },
				},
			],
		};
		const collapsed = renderToolResult(registered, "read", details, {
			args: { path: "docs/spec.pdf", pages: "2-3" },
			width: 50,
		});
		for (const value of ["2-3/10", "2 attached", "2.0 KB", "more"]) expect(collapsed).toContain(value);
		expect(collapsed).not.toContain("secret-page");

		const expanded = renderToolResult(registered, "read", details, {
			expanded: true,
			args: { path: "docs/spec.pdf", pages: "2-3" },
			content: [
				{ type: "text", text: '<pdf path="docs/spec.pdf"/>' },
				{ type: "image", data: "secret-page-two-base64", mimeType: "image/png" },
			],
			width: 50,
		});
		for (const value of ["page 2", "label ii", "image/png", "300x200 pt", "page 3", "rotation 90", "Image resized"]) {
			expect(expanded).toContain(value);
		}
		expect(expanded).not.toContain("secret-page");
	});

	rendererTest("edit 预览异步刷新，折叠时隐藏 diff，展开时恢复", async ({ registered }) => {
		const cwd = editCardTemp.path;
		await writeFile(join(cwd, "app.ts"), "old\n", "utf8");
		const edit = registered.slice().reverse().find((tool) => tool.name === "edit");
		const invalidContext = {
			argsComplete: true,
			cwd,
			expanded: false,
			invalidate: vi.fn(),
			isPartial: true,
			lastComponent: undefined,
			state: {},
		};
		edit?.renderCall?.({ path: "app.ts", edits: [] }, theme, invalidContext);
		expect(invalidContext.invalidate).not.toHaveBeenCalled();
		await expect((await import("../../src/file-tools/pi/adapters/edit.js")).previewEditWorkspace(cwd, {
			path: "app.ts",
			edits: [{ old: "", new: "new" }],
		})).resolves.toMatchObject({ status: "failed", error: { code: "INVALID_OPERATION" } });

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

function rendererTest(
	name: string,
	test: (fixture: Awaited<ReturnType<typeof registerRenderers>>) => Promise<void> | void,
): void {
	it(name, async () => test(await registerRenderers()));
}

async function registerRenderers() {
	const extension = registerExtension(fileTools);
	await activateFileTools(extension.handlers.get("session_start"));
	return extension;
}
