import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { formatErrorModelResult } from "../../src/file-tools/pi/model-output.js";
import { formatEditModelResult } from "../../src/file-tools/edit/presenter.js";
import { formatReadPdfModelSummary, formatReadPdfPageMarker } from "../../src/file-tools/read/presenter.js";
import type { ReadPdfSuccess } from "../../src/file-tools/read/types.js";
import { isGrepSuccessDetails } from "../../src/file-tools/pi/guards.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { lspFileOperations as lspFileHooks } from "../../src/lsp/index.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { executeTool, registerExtension, textResult } from "./extension-fixture.js";

describe("file-tools extension model output", () => {
	const workspace = useTempDir("o-pi-file-output-");

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
		for (const value of [
			"<error>",
			'line 4 old="if (a &lt; b) {\\r\\n\\tcall();\\r\\n}"',
			"next: Retry with the shown old text.",
			"</error>",
		]) expect(formatDrift).toContain(value);

		const anchors = formatErrorModelResult({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_FOUND",
				message: "edits[0].old was not found; one nearby candidate shown.",
				details: { reason: "anchor_candidates", candidates: [{ line: 9, text: "before\ntarget\nafter\n" }] },
			},
		});
		for (const value of ["<error>", 'near line 9 text="before\\ntarget\\nafter\\n"', "</error>"]) {
			expect(anchors).toContain(value);
		}
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
		for (const value of [
			"<error>",
			'line 10 old="const mode = \\\"dev\\\"" new="const mode = \\\"staging\\\""',
			'line 24 old="const mode = \\\"prod\\\"" new="const mode = \\\"staging\\\""',
			"next: Retry with one shown old/new pair; read only if the file changed.",
			"</error>",
		]) expect(output).toContain(value);
	});

	it("read/edit 成功结果给模型返回紧凑文本，完整结构留在 details", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		const originalAfterMutation = lspFileHooks.afterMutation;
		try {
			delete lspFileHooks.afterMutation;
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf8");
			const ctx = { cwd, sessionManager: { getSessionId: () => "session-1", getBranch: () => [] } };
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
			if (originalAfterMutation === undefined) delete lspFileHooks.afterMutation;
			else lspFileHooks.afterMutation = originalAfterMutation;
		}
	});

	it("PDF 模型内容按摘要、物理页码标记和图片交替返回", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		const pdfBytes = await readFile(new URL("./fixtures/read/two-page.pdf", import.meta.url));
		await writeFile(join(cwd, "document.pdf"), pdfBytes);
		const ctx = {
			cwd,
			sessionManager: { getSessionId: () => "session-pdf", getBranch: () => [] },
			model: { api: "anthropic-messages", input: ["text", "image"] },
		};

		const result = await executeTool(registered, "read", { path: "document.pdf" }, ctx);
		expect(result.content).toHaveLength(5);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^<pdf /u) });
		for (const field of [
			'path="document.pdf"',
			'pages="1-2/2"',
			'title="Stage 2 PDF"',
			'author="Pi Tests"',
		]) expect(result.content[0]?.text).toContain(field);
		expect(result.content[1]).toMatchObject({ type: "text", text: expect.stringContaining('number="1"') });
		expect(result.content[1]?.text).toContain('label="i"');
		expect(result.content[2]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(result.content[3]).toMatchObject({ type: "text", text: expect.stringContaining('number="2"') });
		expect(result.content[3]?.text).toContain('label="A-1"');
		expect(result.content[4]).toMatchObject({ type: "image", mimeType: "image/png" });
		for (const block of result.content.filter((item) => item.type === "text")) {
			expect(block.text).not.toContain(result.content[2]?.data);
			expect(block.text).not.toContain(result.content[4]?.data);
		}
		expect(result.details).toMatchObject({
			path: "document.pdf",
			media_type: "pdf",
			start_page: 1,
			end_page: 2,
			pages: [{ number: 1, label: "i" }, { number: 2, label: "A-1" }],
		});

		const nonVision = await executeTool(registered, "read", { path: "document.pdf", pages: "1" }, {
			...ctx,
			model: { api: "anthropic-messages", input: ["text"] },
		});
		expect(nonVision.content).toHaveLength(3);
		expect(nonVision.content[0]?.text).toContain("does not support images");
		expect(nonVision.content.slice(1).every((item) => item.text?.includes("does not support images") !== true)).toBe(true);
	});

	it("PDF 摘要和页面标签过滤控制字符、转义 XML 并按代码点限制 metadata", () => {
		const result: ReadPdfSuccess = {
			path: 'unsafe<&".pdf',
			media_type: "pdf",
			mime_type: "application/pdf",
			size_bytes: 1,
			version: "v",
			start_page: 1,
			end_page: 1,
			total_pages: 3,
			truncated: true,
			continuation: { start_page: 2 },
			metadata: { title: `<&\"\u0000${"😀".repeat(300)}` },
			pages: [],
		};
		const summary = formatReadPdfModelSummary(result);
		expect(summary).toContain('path="unsafe&lt;&amp;&quot;.pdf"');
		expect(summary).toContain('more="2"');
		expect(summary).toContain('title="&lt;&amp;&quot;');
		expect(summary).not.toContain("\u0000");
		expect(summary.match(/😀/gu)).toHaveLength(253);
		expect(summary).not.toContain("author=");

		expect(formatReadPdfPageMarker({
			number: 1,
			label: "1",
			width_points: 1,
			height_points: 1,
			rotation: 0,
			image: { data: "secret-base64", mime_type: "image/png" },
		})).toBe('<pdf_page number="1"/>');
		const marker = formatReadPdfPageMarker({
			number: 2,
			label: '章<&"\u0000',
			width_points: 1,
			height_points: 1,
			rotation: 0,
			image: { data: "secret-base64", mime_type: "image/png" },
			hints: ["hint <safe>\u0000"],
		});
		expect(marker).toContain('label="章&lt;&amp;&quot;"');
		expect(marker).toContain("hint &lt;safe&gt;");
		expect(marker).not.toContain("\u0000");
		expect(marker).not.toContain("secret-base64");
	});

	it("OpenAI completions API 只允许 read 返回文本", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		await writeFile(join(cwd, "a.txt"), "text\n", "utf8");
		const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
		await writeFile(join(cwd, "pixel.gif"), imageBytes);
		await writeFile(join(cwd, "document.pdf"), await readFile(new URL("./fixtures/read/two-page.pdf", import.meta.url)));
		const ctx = {
			cwd,
			sessionManager: { getSessionId: () => "session-completions", getBranch: () => [] },
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

		const pdfRead = await executeTool(registered, "read", { path: "document.pdf" }, ctx);
		expect(textResult(pdfRead)).toBe("<error>\nAPI does not support image format.\n</error>");
		expect(pdfRead.content).toHaveLength(1);
		expect(pdfRead.details).toMatchObject({
			status: "failed",
			error: { code: "API_NOT_SUPPORTED", path: "document.pdf" },
		});
	});

	it("write/edit 返回紧凑结果并限制 LSP 诊断", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		const originalAfterMutation = lspFileHooks.afterMutation;
		try {
			const ctx = { cwd, sessionManager: { getSessionId: () => "session-1", getBranch: () => [] } };
			delete lspFileHooks.afterMutation;
			const clean = await executeTool(registered, "write", { path: "clean.ts", content: "export const ok = true;\n" }, ctx);
			expect(textResult(clean)).toBe('<write path="clean.ts"/>');

			lspFileHooks.afterMutation = vi.fn(async (input) => ({
				status: "errors" as const,
				file_errors: 2,
				file_warnings: 4,
				new_errors: input.changed_ranges === undefined ? 1 : 2,
				new_warnings: 0,
				resolved_errors: 0,
				resolved_warnings: 0,
				baseline: "known" as const,
				total_items: input.changed_ranges === undefined ? 8 : 2,
				items: input.changed_ranges === undefined ? [
					{ severity: "error" as const, line: 12, column: 5, message: "Cannot find name 'foo'.", code: "TS2304" },
					{ severity: "warning" as const, line: 30, column: 7, message: "unused 1" },
					{ severity: "warning" as const, line: 31, column: 7, message: "unused 2" },
					{ severity: "warning" as const, line: 32, column: 7, message: "unused 3" },
					{ severity: "warning" as const, line: 33, column: 7, message: "unused 4" },
					{ severity: "error" as const, line: 40, column: 1, message: "hidden" },
				] : [
					{ severity: "error" as const, line: 12, column: 5, message: "Cannot find name 'foo'.", code: "TS2304" },
					{ severity: "error" as const, line: 40, column: 1, message: "hidden" },
				],
			}));
			const written = await executeTool(registered, "write", { path: "bad-write.ts", content: "foo\n" }, ctx);
			await writeFile(join(cwd, "bad-edit.ts"), "foo\n", "utf8");
			await executeTool(registered, "read", { path: "bad-edit.ts" }, ctx);
			const edited = await executeTool(registered, "edit", { path: "bad-edit.ts", edits: [{ old: "foo", new: "bar" }] }, ctx);

			const writeText = textResult(written);
			expect(writeText).toContain('<write path="bad-write.ts"');
			expect(writeText).toContain('lsp="errors"');
			expect(writeText).toContain("errors=2 warnings=4 new_errors=1 new_warnings=0");
			expect(writeText).toContain("diag error 12:5 Cannot find name 'foo'. (TS2304)");
			expect(writeText).toContain("... 2 more diagnostics");
			expect(written.details).toMatchObject({ status: "written", path: "bad-write.ts", lsp: { diagnostics: { status: "errors" } } });

			const editText = textResult(edited);
			expect(editText).toBe('<edit path="bad-edit.ts" replacements="1" first_changed_line="1">\nnew error at line 12: Cannot find name \'foo\'. (TS2304)\nnew error at line 40: hidden\n</edit>');
			expect(editText).not.toContain("lsp=");
			expect(editText).not.toContain("warning");
			expect(edited.details).toMatchObject({ status: "applied", path: "bad-edit.ts", lsp: { diagnostics: { status: "errors" } } });
		} finally {
			if (originalAfterMutation === undefined) delete lspFileHooks.afterMutation;
			else lspFileHooks.afterMutation = originalAfterMutation;
		}
	});

	it("edit baseline 未知时标记诊断因果关系不确定", () => {
		const text = formatEditModelResult({
			status: "applied",
			path: "src/parser.py",
			replacements: 1,
			old_version: "old",
			new_version: "new",
			old_size_bytes: 1,
			new_size_bytes: 1,
			diff: "",
			lsp: {
				diagnostics: {
					status: "errors",
					file_errors: 1,
					file_warnings: 0,
					new_errors: 0,
					new_warnings: 0,
					resolved_errors: 0,
					resolved_warnings: 0,
					baseline: "unknown",
					total_items: 1,
					items: [{ severity: "error", line: 104, column: 1, message: "bad <type>" }],
				},
			},
		});
		expect(text).toBe('<edit path="src/parser.py" replacements="1">\nerror at line 104 (causality uncertain): bad &lt;type&gt;\n</edit>');
		expect(text).not.toContain("total");
	});

	it("文件工具失败结果给模型返回紧凑 error tag", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		await writeFile(join(cwd, "a.ts"), "const one = 1;\n", "utf8");
		const ctx = { cwd, sessionManager: { getSessionId: () => "session-1", getBranch: () => [] } };
		for (const [tool, params] of [
			["ls", { path: "missing" }],
			["find", { query: " " }],
			["grep", { query: "[" }],
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
		const grepText = textResult(grep);
		expect(grepText).toContain("a.ts");
		expect(grepText).not.toContain("<error");
		expect(grepText).not.toContain('"status"');
		expect(grepText).toContain("a.ts:1 one");
		for (const metadata of ["kind=", "symbol=", "roles=", "matched-by=", "declaration:"]) {
			expect(grepText).not.toContain(metadata);
		}
		for (const legacy of ["lines omitted", "sig|"]) expect(grepText).not.toContain(legacy);
		expect(isGrepSuccessDetails(grep.details)).toBe(true);
		if (!isGrepSuccessDetails(grep.details)) throw new Error("missing grep success details");
		expect(grep.details.approx_tokens).toBe(countTextTokensSync(grepText).tokens);
		expect(grep.details).toMatchObject({ truncated_by: [], stats: { searched_files: 1 }, regions: [expect.objectContaining({ roles: expect.any(Array) })] });

		const partialFind = await executeTool(registered, "find", { query: "a.ts", path: [".", "missing"] }, ctx);
		expect(textResult(partialFind)).toContain("partial; scope_errors=missing:PATH_NOT_FOUND");
		expect(partialFind.details).toMatchObject({ paths: ["."], scope_errors: [{ path: "missing" }] });

		const partialGrep = await executeTool(registered, "grep", { query: "one", path: [".", "missing"] }, ctx);
		expect(textResult(partialGrep)).toContain("partial; scope_errors=missing:PATH_NOT_FOUND");
		expect(partialGrep.details).toMatchObject({ paths: ["."], scope_errors: [{ path: "missing" }] });
	});
});
