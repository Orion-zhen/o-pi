import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { lspFileHooks } from "../../src/lsp/index.js";

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

type ToolResultHandler = (event: { toolName: string; details: unknown }) => unknown;
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

	it("文件工具失败结果标记为错误，并按失败分支渲染", () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, ToolResultHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: ToolResultHandler) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI);

		const failure = {
			status: "failed" as const,
			error: { code: "INVALID_PATH", message: "path must be workspace-relative.", path: "C:/Users/orion/.pi" },
		};
		expect(handlers.get("tool_result")?.({ toolName: "find", details: failure })).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({ toolName: "find", details: { total: 0 } })).toBeUndefined();

		for (const toolName of ["ls", "find", "grep", "read"]) {
			const output = renderToolResult(registered, toolName, failure);
			expect(output).toContain("INVALID_PATH: path must be workspace-relative.");
			expect(output).not.toContain('"status": "failed"');
		}
	});

	it("find 使用自定义调用和结果 renderer 展示 strategy、类型、折叠组和扫描统计", () => {
		const registered: Array<{ name: string; renderCall?: RenderCall; renderResult?: RenderResult }> = [];
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);
		const find = registered.find((tool) => tool.name === "find");
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
			truncated: true,
		};
		const collapsed = find?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false },
			theme,
			{ lastComponent: undefined },
		);
		const collapsedOutput = collapsed?.render(120).join("\n") ?? "";
		expect(collapsedOutput.split("\n")).toHaveLength(2);
		expect(collapsedOutput).toContain("5 matches · 1 file · 1 directory · fuzzy · truncated");

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
		expect(output).toContain("Truncated.");
	});

	it("edit 完成后成功和失败结果都保留 tool card 背景，折叠态成功结果展示 diff", () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

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
		expect(success).toContain("-old");
		expect(success).toContain("+new");

		const failure = renderEditResult(registered, {
			status: "failed",
			error: { code: "OLD_TEXT_NOT_FOUND", message: "edits[0].old was not found in the original file." },
		});
		expect(failure).toContain("toolErrorBg");
		expect(failure).toContain("OLD_TEXT_NOT_FOUND: edits[0].old was not found in the original file.");
	});

	it("write 完成后折叠态成功结果展示 diff", () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const output = renderWriteResult(registered, {
			status: "written",
			path: "src/app.ts",
			bytes: 4,
			diff: "-1 old\n+1 new",
		});
		expect(output).toContain("write     src/app.ts");
		expect(output).toContain("+1 -1");
		expect(output).toContain("-1 old");
		expect(output).toContain("+1 new");
	});

	it("edit 参数完整后的折叠调用预览展示 diff", async () => {
		const registered: Array<{ name: string; renderCall?: RenderCall }> = [];
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-edit-card-"));
		await writeFile(join(cwd, "app.ts"), "old\n", "utf8");
		const edit = registered.find((tool) => tool.name === "edit");
		const args = { path: "app.ts", edits: [{ old: "old", new: "new" }] };
		const context = {
			args,
			argsComplete: true,
			cwd,
			expanded: false,
			invalidate() {},
			isPartial: true,
			lastComponent: undefined,
			state: {},
		};

		const first = edit?.renderCall?.(args, theme, context);
		const output = await renderEditCallAfterPreview(edit, args, context, first);
		expect(output).toContain("edit      app.ts");
		expect(output).toContain("-1 old");
		expect(output).toContain("+1 new");
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
		try {
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
			expect(textResult(clean)).toBe('<write path="clean.ts" lsp="clean"/>');
			expect(clean.details).toMatchObject({ status: "written", path: "clean.ts", diff: expect.stringContaining("+1 export const ok = true;") });

			lspFileHooks.afterWrite = vi.fn(async () => ({
				status: "errors" as const,
				file_errors: 2,
				file_warnings: 4,
				new_errors: 1,
				new_warnings: 0,
				resolved_errors: 0,
				resolved_warnings: 0,
				baseline: "known" as const,
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
				"... 1 more diagnostics",
				"</write>",
			].join("\n"));
			expect(errored.details).toMatchObject({ status: "written", diff: expect.stringContaining("+1 foo"), lsp: { diagnostics: { status: "errors", items: expect.any(Array) } } });
		} finally {
			if (originalAfterWrite === undefined) delete lspFileHooks.afterWrite;
			else lspFileHooks.afterWrite = originalAfterWrite;
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
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

function renderToolResult(registered: Array<{ name: string; renderResult?: RenderResult }>, toolName: string, details: unknown): string {
	const tool = registered.find((item) => item.name === toolName);
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded: false, isPartial: false },
		theme,
		{ cwd: "C:/Users/orion/.pi" },
	);
	return component?.render(120).join("\n") ?? "";
}

function renderEditResult(registered: Array<{ name: string; renderResult?: RenderResult }>, details: unknown): string {
	const tool = registered.find((item) => item.name === "edit");
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded: false, isPartial: false },
		theme,
		{
			args: { path: "src/app.ts", edits: [{ old: "old", new: "new" }] },
			cwd: "/repo",
			expanded: false,
			lastComponent: undefined,
			state: {},
		},
	);
	return component?.render(120).join("\n") ?? "";
}

function renderWriteResult(registered: Array<{ name: string; renderResult?: RenderResult }>, details: unknown): string {
	const tool = registered.find((item) => item.name === "write");
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded: false, isPartial: false },
		theme,
		{
			args: { path: "src/app.ts", content: "new" },
			cwd: "/repo",
			lastComponent: undefined,
		},
	);
	return component?.render(120).join("\n") ?? "";
}

async function renderEditCallAfterPreview(
	edit: { renderCall?: RenderCall } | undefined,
	args: unknown,
	context: Record<string, unknown>,
	first: Renderable | undefined,
): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		const component = edit?.renderCall?.(args, theme, { ...context, lastComponent: first });
		const output = component?.render(120).join("\n") ?? "";
		if (output.includes("old") && output.includes("new")) return output;
	}
	return edit?.renderCall?.(args, theme, { ...context, lastComponent: first })?.render(120).join("\n") ?? "";
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
