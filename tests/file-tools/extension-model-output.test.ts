import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { formatErrorModelResult } from "../../src/file-tools/pi/model-output.js";
import { lspFileOperations as lspFileHooks } from "../../src/lsp/index.js";
import { executeTool, textResult, type ExecuteTool } from "./extension-fixture.js";

describe("file-tools extension model output", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("将 not-found 恢复候选输出为紧凑且转义安全的文本", () => {
		const formatDrift = formatErrorModelResult({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_FOUND",
				message: "edits[0].old was not found exactly; one formatting-equivalent candidate exists.",
				next: "Retry with the shown old text.",
				details: {
					reason: "format_drift",
					candidates: [{ line: 4, old: "if (a < b) {\r\n\tcall();\r\n}" }],
				},
			},
		});
		expect(formatDrift).toBe(`<error>
 edits[0].old was not found exactly; one formatting-equivalent candidate exists.
 line 4 old="if (a &lt; b) {\\r\\n\\tcall();\\r\\n}"
 next: Retry with the shown old text.
 </error>`.replaceAll("\n ", "\n"));

		const anchors = formatErrorModelResult({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_FOUND",
				message: "edits[0].old was not found; one nearby candidate shown.",
				details: { reason: "anchor_candidates", candidates: [{ line: 9, text: "before\ntarget\nafter\n" }] },
			},
		});
		expect(anchors).toBe(`<error>
 edits[0].old was not found; one nearby candidate shown.
 near line 9 text="before\\ntarget\\nafter\\n"
 </error>`.replaceAll("\n ", "\n"));
	});

	it("将重复 old 的匹配提示压缩为可直接重试的行", () => {
		const output = formatErrorModelResult({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_UNIQUE",
				message: "edits[0].old matched 6 locations, 2 shown.",
				next: "Retry with one shown old/new pair; read only if the file changed.",
				details: {
					matches: 6,
					shown: 2,
					hints: [
						{ line: 10, old: 'const mode = "dev"', new: 'const mode = "staging"' },
						{ line: 24, old: 'const mode = "prod"', new: 'const mode = "staging"' },
					],
				},
			},
		});
		expect(output).toBe(`<error>
 edits[0].old matched 6 locations, 2 shown.
 line 10 old="const mode = \\\"dev\\\"" new="const mode = \\\"staging\\\""
 line 24 old="const mode = \\\"prod\\\"" new="const mode = \\\"staging\\\""
 next: Retry with one shown old/new pair; read only if the file changed.
 </error>`.replaceAll("\n ", "\n"));
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
		const originalAfterEdit = lspFileHooks.afterWrite;
		try {
			delete lspFileHooks.afterWrite;
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
			expect(textResult(failedRead)).toContain('<error>\nFile does not exist.\n</error>');
		} finally {
			if (originalAfterEdit === undefined) delete lspFileHooks.afterWrite;
			else lspFileHooks.afterWrite = originalAfterEdit;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("OpenAI completions API 只允许 read 返回文本", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		fileTools({
			registerTool(tool: { name: string; execute?: ExecuteTool }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-read-completions-output-"));
		try {
			await writeFile(join(cwd, "a.txt"), "text\n", "utf8");
			const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
			await writeFile(join(cwd, "pixel.gif"), imageBytes);
			const ctx = {
				cwd,
				sessionManager: { getSessionId: () => "session-completions" },
				model: { api: "openai-completions", input: ["text", "image"] },
			};

			const textRead = await executeTool(registered, "read", { path: "a.txt" }, ctx);
			expect(textResult(textRead)).toBe('<read path="a.txt" lines="1-1/1">\ntext\n</read>');

			const imageRead = await executeTool(registered, "read", { path: "pixel.gif" }, ctx);
			expect(textResult(imageRead)).toBe("<error>\nAPI does not support image format.\n</error>");
			expect(imageRead.content).toHaveLength(1);
			expect(imageRead.details).toMatchObject({
				status: "failed",
				error: { code: "API_NOT_SUPPORTED", message: "API does not support image format.", path: "pixel.gif" },
			});
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
			expect(textResult(clean)).toBe('<write path="clean.ts"/>');
			expect(clean.details).toMatchObject({ status: "written", path: "clean.ts", diff: expect.stringContaining("+1 export const ok = true;") });

			const edited = await executeTool(registered, "edit", { path: "clean.ts", edits: [{ old: "true", new: "false" }] }, ctx);
			expect(edited.details).toMatchObject({ status: "applied", path: "clean.ts" });

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
		const originalAfterEdit = lspFileHooks.afterWrite;
		try {
			await writeFile(join(cwd, "bad.ts"), "foo\n", "utf8");
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
			if (originalAfterEdit === undefined) delete lspFileHooks.afterWrite;
			else lspFileHooks.afterWrite = originalAfterEdit;
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
				expect(text).toMatch(/^<error>\n[^]+\n<\/error>$/);
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
