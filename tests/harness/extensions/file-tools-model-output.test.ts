import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import fileTools from "../../../src/harness/extensions/file-tools.ts";
import { formatCompactGrepResult } from "../../../src/harness/file-tools/grep/command.ts";
import { formatErrorModelResult } from "../../../src/harness/file-tools/pi/model-output.ts";
import { formatEditModelResult } from "../../../src/harness/file-tools/edit/presenter.ts";
import { formatWriteModelResult } from "../../../src/harness/file-tools/write/presenter.ts";
import { formatReadPdfModelSummary, formatReadPdfPageMarker, formatReadStructureContext } from "../../../src/harness/file-tools/read/presenter.ts";
import type { ReadPdfSuccess } from "../../../src/harness/file-tools/read/types.ts";
import { isGrepSuccessDetails } from "../../../src/harness/file-tools/pi/guards.ts";
import { countTextTokensSync } from "../../../src/harness/token-counter.ts";
import { lspManager as lspFileHooks } from "../../../src/harness/lsp/index.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
import { executeTool, textResult } from "../file-tools/extension-fixture.ts";

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

	it("多范围 read 通过扩展返回有原始坐标的片段，不输出间隔正文", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		await writeFile(join(cwd, "ranges.txt"), "one\nskipped\nthree\nfour\n");
		const ctx = { cwd, sessionManager: { getSessionId: () => "ranges", getBranch: () => [] } };
		const result = await executeTool(registered, "read", { path: "ranges.txt", lines: "3-4,1" }, ctx);
		expect(result.details).toMatchObject({ segments: [{ start_line: 1, end_line: 1 }, { start_line: 3, end_line: 4 }] });
	});

	it("read/edit 成功结果给模型返回紧凑文本，完整结构留在 details", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		const originalAfterMutation = lspFileHooks.afterMutation;
		try {
			lspFileHooks.afterMutation = async () => undefined;
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf8");
			const ctx = { cwd, sessionManager: { getSessionId: () => "session-1", getBranch: () => [] } };
			const read = await executeTool(registered, "read", { path: "a.ts" }, ctx);
			const readText = textResult(read);
			expect(read.structuredContent).toBe(readText);
			expect(readText).not.toContain('"encoding"');
			expect(read.details).toMatchObject({ path: "a.ts", segments: [{ content: "one\ntwo\n" }], encoding: "utf-8", bom: false });

			const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
			await writeFile(join(cwd, "pixel.gif"), imageBytes);
			const imageRead = await executeTool(registered, "read", { path: "pixel.gif" }, ctx);
			expect(imageRead.content).toEqual([
				{ type: "text", text: expect.any(String) },
				{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/gif" },
			]);
			expect(imageRead.structuredContent).toEqual({ type: "image", data: imageBytes.toString("base64"), mimeType: "image/gif", note: textResult(imageRead) });
			expect(imageRead.details).toMatchObject({ path: "pixel.gif", media_type: "image", image: { mime_type: "image/gif" } });

			const edit = await executeTool(registered, "edit", { path: "a.ts", edits: [{ old: "two", new: "TWO" }] }, ctx);
			const editText = textResult(edit);
			expect(editText).not.toContain('"diff"');
			expect(edit.details).toMatchObject({ status: "applied", path: "a.ts", replacements: 1, diff: expect.stringContaining("+2 TWO") });

		} finally {
			lspFileHooks.afterMutation = originalAfterMutation;
		}
	});

	it("PDF 模型内容按摘要、物理页码标记和图片交替返回", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		const pdfBytes = await readFile(new URL("../file-tools/fixtures/read/two-page.pdf", import.meta.url));
		await writeFile(join(cwd, "document.pdf"), pdfBytes);
		const ctx = {
			cwd,
			sessionManager: { getSessionId: () => "session-pdf", getBranch: () => [] },
			model: { api: "anthropic-messages", input: ["text", "image"] },
		};

		const result = await executeTool(registered, "read", { path: "document.pdf" }, ctx);
		expect(result.structuredContent).toEqual({ type: "pdf", content: result.content });
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
			pages: [{ number: 1, label: "i" }, { number: 2, label: "A-1" }],
		});

		const nonVision = await executeTool(registered, "read", { path: "document.pdf", pages: "1" }, {
			...ctx,
			model: { api: "anthropic-messages", input: ["text"] },
		});
		expect(nonVision.content).toHaveLength(3);
	});

	it("PDF 摘要和页面标签过滤控制字符、转义 XML 并按代码点限制 metadata", () => {
		const result: ReadPdfSuccess = {
			path: 'unsafe<&".pdf',
			media_type: "pdf",
			mime_type: "application/pdf",
			size_bytes: 1,
			version: "v",
			total_pages: 3,
			truncated: true,
			continuation: { pages: "2" },
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

	it("OpenAI completions 视觉模型保留图片和 PDF 页面，交由 provider 转换", async () => {
		const { registered } = registerExtension(fileTools);
		const cwd = workspace.path;
		await writeFile(join(cwd, "a.txt"), "text\n", "utf8");
		const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
		await writeFile(join(cwd, "pixel.gif"), imageBytes);
		await writeFile(join(cwd, "document.pdf"), await readFile(new URL("../file-tools/fixtures/read/two-page.pdf", import.meta.url)));
		const ctx = {
			cwd,
			sessionManager: { getSessionId: () => "session-completions", getBranch: () => [] },
			model: { api: "openai-completions", input: ["text", "image"] },
		};

		const imageRead = await executeTool(registered, "read", { path: "pixel.gif" }, ctx);
		expect(imageRead.content).toEqual([
			{ type: "text", text: expect.any(String) },
			{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/gif" },
		]);
		expect(imageRead.details).toMatchObject({ path: "pixel.gif", media_type: "image" });

		const pdfRead = await executeTool(registered, "read", { path: "document.pdf" }, ctx);
		expect(pdfRead.content.map((block) => block.type)).toEqual(["text", "text", "image", "text", "image"]);
		expect(pdfRead.content.filter((block) => block.type === "image")).toEqual([
			{ type: "image", data: expect.any(String), mimeType: "image/png" },
			{ type: "image", data: expect.any(String), mimeType: "image/png" },
		]);
		expect(pdfRead.details).toMatchObject({ path: "document.pdf", media_type: "pdf" });
	});

	it("read 隐藏解析恢复和关联冲突状态，只展示结构导航", () => {
		const range = { startLine: 1, endLine: 4, startByte: 0, endByte: 40 };
		const status = {
			parse_errors: [range],
			conflicts: [
				{ path: "a.ts", kind: "range" as const, range },
				{ path: "a.ts", kind: "ambiguous" as const, range },
			],
		};
		expect(formatReadStructureContext(status)).toBeUndefined();
		expect(formatReadStructureContext({
			...status,
			enclosing_symbol: { name: "outer", kind: "function", line: 1, end_line: 4 },
			remaining_symbols: [{ name: "next", kind: "function", line: 6, end_line: 9 }],
		})).toBe('<structure enclosing="function outer 1-4"/>\n<remaining_symbols>\nline 6-9: function next\n</remaining_symbols>');
	});

	it("write 模型结果保留有界诊断摘要，不暴露 LSP 状态", () => {
		const text = formatWriteModelResult({
			status: "written", path: "bad.ts", bytes: 4, action: "create", after_version: "new", after_size_bytes: 4, diff: "",
			lsp: { diagnostics: {
				status: "errors", file_errors: 2, file_warnings: 4, new_errors: 1, new_warnings: 0,
				resolved_errors: 0, resolved_warnings: 0, baseline: "known", total_items: 2,
				items: [
					{ severity: "error", line: 12, column: 5, message: "Cannot find name 'foo'.", code: "TS2304", hint: "Import foo from <module>" },
					{ severity: "error", line: 40, column: 1, message: "hidden" },
				],
			} },
		});
		for (const value of ["errors=2 warnings=4", "Cannot find name 'foo'.", "hidden", "hint: Import foo from &lt;module&gt;"]) expect(text).toContain(value);
		expect(text).not.toContain("lsp=");
	});

	it("edit/write 展示当前有界错误清单，不展示已修复计数或诊断服务状态", () => {
		const diagnostics = {
			status: "errors" as const, file_errors: 3, file_warnings: 0, new_errors: 1, new_warnings: 0,
			resolved_errors: 2, resolved_warnings: 0, baseline: "known" as const, total_items: 3,
			items: [
				{ severity: "error" as const, line: 8, column: 1, message: "new problem", change: "new" as const },
				{ severity: "error" as const, line: 3, column: 1, message: "still broken", change: "existing" as const },
			],
		};
		const edit = {
			status: "applied" as const, path: "a.ts", replacements: 1, old_version: "old", new_version: "new",
			old_size_bytes: 1, new_size_bytes: 1, diff: "",
		};
		const write = {
			status: "written" as const, path: "a.ts", bytes: 1, action: "modify" as const, after_version: "new", after_size_bytes: 1, diff: "",
		};
		for (const output of [formatEditModelResult({ ...edit, lsp: { diagnostics } }), formatWriteModelResult({ ...write, lsp: { diagnostics } })]) {
			expect(output).toContain("errors=3");
			expect(output).toContain("still broken");
			expect(output).not.toMatch(/resolved|clean|lsp=/u);
		}
		const cleared = { ...diagnostics, status: "clean" as const, file_errors: 0, new_errors: 0, total_items: 0, items: [] };
		expect(formatEditModelResult({ ...edit, lsp: { diagnostics: cleared } })).toBe('<edit path="a.ts" replacements="1"/>');
		expect(formatWriteModelResult({ ...write, lsp: { diagnostics: cleared } })).toBe('<write path="a.ts"/>');
		for (const status of ["timeout", "unavailable"] as const) {
			const failed = { ...cleared, status };
			expect(formatEditModelResult({ ...edit, lsp: { diagnostics: failed } })).toBe('<edit path="a.ts" replacements="1"/>');
			expect(formatWriteModelResult({ ...write, lsp: { diagnostics: failed } })).toBe('<write path="a.ts"/>');
		}
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
		}

		const grep = await executeTool(registered, "grep", { query: "one" }, ctx);
		const grepText = textResult(grep);
		expect(grepText).toContain("a.ts");
		expect(grepText).not.toContain("<error");
		expect(grepText).not.toContain('"status"');
		for (const metadata of ["kind=", "symbol=", "roles=", "matched-by=", "declaration:"]) {
			expect(grepText).not.toContain(metadata);
		}
		for (const legacy of ["lines omitted", "sig|"]) expect(grepText).not.toContain(legacy);
		expect(isGrepSuccessDetails(grep.details)).toBe(true);
		if (!isGrepSuccessDetails(grep.details)) throw new Error("missing grep success details");
		expect(grep.details.approx_tokens).toBe(countTextTokensSync(grepText).tokens);
		expect(grep.details).toMatchObject({ truncated_by: [], stats: { searched_files: 1 }, regions: [expect.objectContaining({ roles: expect.any(Array) })] });
		for (const status of ["ok", "unsupported", "unavailable", "timeout", "skipped"] as const) {
			const enhanced = formatCompactGrepResult({
				...grep.details,
				analysis: [{ path: "a.ts", symbols: status, workspaceSymbols: status }],
				structure_issues: [{ path: "a.ts", kind: "ambiguous", range: { startByte: 0, endByte: 10, startLine: 1, endLine: 1 } }],
				regions: grep.details.regions.map((region) => ({
					...region,
					relation_status: { incomingCalls: status, outgoingCalls: status, references: status, definitions: status, validation: status },
					navigation: [
						{ kind: "caller", source: "hierarchy", path: "caller.ts", line: 2, column: 3 },
						{ kind: "callee", source: "definition", ambiguous: true, path: "dep.ts", line: 4, column: 5 },
					],
				})),
			});
			expect(enhanced).toContain("caller: caller.ts:2:3");
			expect(enhanced).toContain("callee?: dep.ts:4:5");
			expect(enhanced).not.toMatch(/lsp|tree.sitter|hierarchy|definition|relation_status|structure_issues|ambiguous|unsupported|unavailable|timeout|skipped|validation/iu);
		}

		const partialFind = await executeTool(registered, "find", { query: "a.ts", path: [".", "missing"] }, ctx);
		expect(partialFind.details).toMatchObject({ paths: ["."], scope_errors: [{ path: "missing" }] });

		const partialGrep = await executeTool(registered, "grep", { query: "one", path: [".", "missing"] }, ctx);
		expect(partialGrep.details).toMatchObject({ paths: ["."], scope_errors: [{ path: "missing" }] });
	});
});
