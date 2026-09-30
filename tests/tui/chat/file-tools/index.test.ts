import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createFileToolsExtension } from "../../../../src/harness/extensions/file-tools.ts";
import { presentation } from "../../../../src/tui/extensions.ts";
const fileTools = createFileToolsExtension(presentation.fileTools);
import { registerExtension } from "../../../helpers/extension.ts";
import { useTempDir } from "../../../helpers/lifecycle.ts";
import { activateFileTools, renderToolResult, theme, type Renderable } from "../../../harness/file-tools/extension-fixture.ts";

const editCardTemp = useTempDir("o-pi-edit-card-");

describe("file-tools extension renderers", () => {
	beforeAll(() => initTheme());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	rendererTest("失败和部分结果保持正确状态且不丢失错误信息", async ({ registered }) => {
		const failure = {
			status: "failed" as const,
			error: { code: "INVALID_PATH", message: "path must be workspace-relative.", path: "src/missing" },
		};

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
			scope_errors: [{ path: "missing", error: { code: "PATH_NOT_FOUND", message: "missing" } }],
		}, { expanded: true });

		for (const value of ["src/main.ts", "missing", "PATH_NOT_FOUND"]) expect(output).toContain(value);
	});

	rendererTest("read 多片段摘要和展开内容都保留真实范围", async ({ registered }) => {
		const details = {
			path: "ranges.txt", segments: [
				{ start_line: 1, end_line: 1, content: "one\n" },
				{ start_line: 8, end_line: 9, content: "eight\nnine\n" },
			],
			total_lines: 10, size_bytes: 50, version: "v", encoding: "utf-8", newline: "lf", bom: false, truncated: false,
		};
		const collapsed = renderToolResult(registered, "read", details, { width: 150 });
		expect(collapsed).toContain("1-1,8-9/10");
		const expanded = renderToolResult(registered, "read", details, { width: 150, expanded: true });
		expect(expanded).toContain('<lines range="8-9">');
		expect(expanded).toContain("eight");
	});

	rendererTest("PDF 展开与折叠都不泄露 Base64", async ({ registered }) => {
		const details = {
			path: "docs/spec.pdf",
			media_type: "pdf",
			mime_type: "application/pdf",
			size_bytes: 2048,
			version: "version",
			total_pages: 10,
			truncated: true,
			continuation: { pages: "4-10" },
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
		expect(expanded).not.toContain("secret-page");
	});

	rendererTest("write 从空内容流式追加到多行，完成参数后保持完整预览", ({ registered }) => {
		const write = registered.slice().reverse().find((tool) => tool.name === "write");
		const state = {};
		let lastComponent: Renderable | undefined;
		for (const content of ["", "// first line", "// first line\n// second line"]) {
			lastComponent = write?.renderCall?.({ path: "app.ts", content }, theme, {
				cwd: editCardTemp.path, argsComplete: false, expanded: true, isPartial: true, state, lastComponent,
			});
			const output = lastComponent?.render(80).join("\n");
			for (const line of content.split("\n")) expect(output).toContain(line);
		}
		const completed = write?.renderCall?.({ path: "app.ts", content: "// first line\n// second line" }, theme, {
			cwd: editCardTemp.path, argsComplete: true, expanded: true, isPartial: true, state, lastComponent,
		});
		expect(completed?.render(80).join("\n")).toContain("// second line");
	});

	rendererTest("edit 预览异步刷新，折叠时隐藏 diff，展开时恢复", async ({ registered }) => {
		const cwd = editCardTemp.path;
		await writeFile(join(cwd, "app.ts"), "old\n", "utf8");
		const edit = registered.slice().reverse().find((tool) => tool.name === "edit");
		const invalidContext = {
			argsComplete: true,
			cwd,
			expanded: true,
			invalidate: vi.fn(),
			isPartial: true,
			lastComponent: undefined,
			state: {},
		};
		const invalidArgs = { path: "app.ts", edits: [] };
		const invalidCall = edit?.renderCall?.(invalidArgs, theme, invalidContext);
		await vi.waitFor(() => expect(invalidContext.invalidate).toHaveBeenCalledOnce());
		const failedPreview = edit?.renderCall?.(invalidArgs, theme, { ...invalidContext, lastComponent: invalidCall });
		expect(failedPreview?.render(80).join("\n")).toContain("INVALID_OPERATION");
		await expect((await import("../../../../src/harness/file-tools/pi/adapters/edit.ts")).previewEditWorkspace(cwd, {
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
