import { mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fileTypeDetector = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("file-type", async (importOriginal) => {
	const actual = await importOriginal<typeof import("file-type")>();
	return {
		...actual,
		async fileTypeFromBuffer(...args: Parameters<typeof actual.fileTypeFromBuffer>) {
			if (fileTypeDetector.shouldThrow) throw new Error("simulated file type detection failure");
			return await actual.fileTypeFromBuffer(...args);
		},
	};
});

import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { contentHash as sha256Version } from "../../src/filesystem/services/text.js";
import { createPdfDocumentSource } from "../../src/file-tools/pi/ports/read-pdf.js";
import type {
	InlineImageProcessor,
	PdfDocumentHandle,
	PdfDocumentSource,
	PdfPageRenderResult,
} from "../../src/file-tools/read/ports.js";
import { formatReadStructureContext } from "../../src/file-tools/read/presenter.js";
import { readWorkspaceFile } from "../helpers/read-tool.js";
import { createCrudTestContext } from "./crud-fixtures.js";

const testContext = createCrudTestContext();
let workspace: string;
let outside: string;

beforeEach(() => {
	workspace = testContext.workspace;
	outside = testContext.outside;
	fileTypeDetector.shouldThrow = false;
});

describe("read", () => {
	it("文件不存在时为 workspace 内路径附加相似路径建议", async () => {
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(path.join(workspace, "src", "main.ts"), "export const main = 1;\n");

		const result = await testContext.read({ path: "src/maim.ts" });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "FILE_NOT_FOUND",
				next: expect.stringContaining("Related paths: src/main.ts"),
			},
		});
	});

	it("workspace 外路径不存在时不附加路径建议", async () => {
		const result = await testContext.read({ path: path.join(outside, "main.ts") });
		expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
		if ("status" in result) expect(result.error.next).toBeUndefined();
	});

	it("空 workspace 没有相似文件时保持原始 FILE_NOT_FOUND 错误", async () => {
		const result = await testContext.read({ path: "missing-completely.ts" });
		expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
		if ("status" in result) expect(result.error.next).toBeUndefined();
	});

	it("配置 read_suggestion_limit 控制建议数量", async () => {
		await writeFile(path.join(workspace, "main.ts"), "");
		await writeFile(path.join(workspace, "main.test.ts"), "");
		await testContext.useConfig({ limits: { read_suggestion_limit: 1 } });

		const result = await testContext.read({ path: "main.mts" });
		expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
		if ("status" in result) {
			expect(result.error.next).toMatch(/^Related paths: [^,]+$/u);
		}
	});

	it("模型输出只展示未出现的顶层 remaining symbols", () => {
		expect(formatReadStructureContext({
			remaining_symbols: [
				{ line: 240, end_line: 418, kind: "class", name: "RequestParser" },
				{ line: 412, end_line: 487, kind: "function", name: "validate_config" },
			],
		})).toBe(
			"<remaining_symbols>\nline 240-418: class RequestParser\nline 412-487: function validate_config\n</remaining_symbols>",
		);
	});

	it("读取完整 UTF-8 文件并返回版本和元数据", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\n", "utf8");
		const result = await testContext.read({ path: "a.txt" });
		expect(result).toMatchObject({
			path: "a.txt",
			content: "one\ntwo\n",
			start_line: 1,
			end_line: 2,
			total_lines: 2,
			encoding: "utf-8",
			newline: "lf",
			truncated: false,
			bom: false,
		});
		if ("version" in result) expect(result.version).toBe(sha256Version(Buffer.from("one\ntwo\n")));
	});

	it("读取图片文件并返回模型可内联图片数据", async () => {
		const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
		await writeFile(path.join(workspace, "pixel.gif"), imageBytes);
		const result = await testContext.read({ path: "pixel.gif" });
		expect(result).toMatchObject({
			path: "pixel.gif",
			media_type: "image",
			mime_type: "image/gif",
			content: "Read image file [image/gif]",
			size_bytes: imageBytes.byteLength,
			image: {
				data: imageBytes.toString("base64"),
				mime_type: "image/gif",
			},
		});
		if ("version" in result) expect(result.version).toBe(sha256Version(imageBytes));

		let processedUnsupportedImage = false;
		const unsupported = await testContext.read({ path: "pixel.gif" }, {
			supportedOutputFormats: ["text"],
			image: {
				async process() {
					processedUnsupportedImage = true;
					throw new Error("unsupported image must not be processed");
				},
			},
		});
		expect(unsupported).toMatchObject({
			status: "failed",
			error: { code: "API_NOT_SUPPORTED", message: "API does not support image format.", path: "pixel.gif" },
		});
		expect(processedUnsupportedImage).toBe(false);

		for (const params of [{ path: "pixel.gif", lines: "1" }, { path: "pixel.gif", pages: "1" }]) {
			expect(await testContext.read(params)).toMatchObject({
				status: "failed",
				error: { code: "INVALID_OPERATION" },
			});
		}
	});

	it("图片处理异常直接传播，取消仍优先返回 OPERATION_ABORTED", async () => {
		const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
		await writeFile(path.join(workspace, "pixel.gif"), imageBytes);

		await expect(testContext.read({ path: "pixel.gif" }, {
			image: {
				async process() {
					throw new Error("simulated image conversion failure");
				},
			},
		})).rejects.toThrow("simulated image conversion failure");

		const controller = new AbortController();
		const cancelled = await testContext.read({ path: "pixel.gif" }, {
			signal: controller.signal,
			image: {
				async process() {
					controller.abort();
					throw new Error("simulated cancellation during image conversion");
				},
			},
		});
		expect(cancelled).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
	});

	it("文件类型检测异常直接传播，不再按文本继续", async () => {
		await writeFile(path.join(workspace, "plain.txt"), "plain text\n");
		fileTypeDetector.shouldThrow = true;

		await expect(testContext.read({ path: "plain.txt" })).rejects.toThrow("simulated file type detection failure");
	});

	it("即使只请求局部行范围也拒绝超过 read 单文件上限的文件", async () => {
		await testContext.useConfig({ limits: { read_max_file_bytes: 1024 } });
		await writeFile(path.join(workspace, "exact.txt"), "x".repeat(1024));
		expect(await testContext.read({ path: "exact.txt" })).toMatchObject({
			content: "x".repeat(1024),
			size_bytes: 1024,
		});
		await writeFile(path.join(workspace, "oversized.txt"), `${"x".repeat(1024)}\n`);
		expect(await testContext.read({ path: "oversized.txt", lines: "1" })).toMatchObject({
			status: "failed",
			error: {
				code: "OUTPUT_LIMIT_EXCEEDED",
				path: "oversized.txt",
				details: { limit: 1024, size: 1025 },
			},
		});
	});

	it.each([
		["2", { content: "two\n", start_line: 2, end_line: 2, total_lines: 3 }],
		["2-", { content: "two\nthree\n", start_line: 2, end_line: 3, total_lines: 3 }],
		["2-99", { content: "two\nthree\n", start_line: 2, end_line: 3, total_lines: 3, truncated: false }],
	] as const)("按行范围 %s 读取", async (lines, expected) => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\n", "utf8");
		expect(await testContext.read({ path: "a.txt", lines })).toMatchObject(expected);
	});

	it("处理空文件、无尾部换行、CRLF 和 UTF-8 BOM", async () => {
		await writeFile(path.join(workspace, "empty.txt"), "");
		await writeFile(path.join(workspace, "nonewline.txt"), "one");
		await writeFile(path.join(workspace, "crlf.txt"), "one\r\ntwo\r\n");
		await writeFile(path.join(workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\n")]));
		expect(await testContext.read({ path: "empty.txt" })).toMatchObject({
			content: "",
			total_lines: 0,
			newline: "none",
		});
		expect(await testContext.read({ path: "nonewline.txt" })).toMatchObject({
			content: "one",
			total_lines: 1,
			newline: "none",
		});
		expect(await testContext.read({ path: "crlf.txt" })).toMatchObject({ newline: "crlf" });
		expect(await testContext.read({ path: "bom.txt" })).toMatchObject({ content: "one\n", bom: true });
	});

	it("截断时返回 continuation", async () => {
		await testContext.useConfig({ limits: { read_lines: 2 } });
		await writeFile(path.join(workspace, "big.txt"), "one\ntwo\nthree\n");
		const result = await testContext.read({ path: "big.txt" });
		expect(result).toMatchObject({ truncated: true, continuation: { start_line: 3 }, end_line: 2 });
	});

	it("仅在保留 structure 时为其预算重新切片", async () => {
		await testContext.useConfig({ limits: { read_bytes: 1024, read_lines: 2 } });
		await writeFile(path.join(workspace, "structured.ts"), "one\ntwo\nthree\n");
		const truncated = await testContext.read({ path: "structured.ts" });
		expect(truncated).toMatchObject({ truncated: true, continuation: { start_line: 3 } });

		const partial = await testContext.read({ path: "structured.ts", lines: "2" });
		expect(partial).toMatchObject({ content: "two\n", start_line: 2, end_line: 2 });

		const oversized = await testContext.read({ path: "structured.ts", lines: "2" }, {
			structure: {
				async context() {
					return { enclosing_symbol: { name: "x".repeat(1024), kind: "function", line: 1, end_line: 3 } };
				},
			},
		});
		expect(oversized).not.toHaveProperty("lsp");

		const fitting = await testContext.read({ path: "structured.ts", lines: "2" }, {
			structure: {
				async context() {
					return { enclosing_symbol: { name: "demo", kind: "function", line: 1, end_line: 3 } };
				},
			},
		});
		expect(fitting).toMatchObject({ lsp: { enclosing_symbol: { name: "demo" } } });
	});

	it.each([
		"9007199254740992", "1-9007199254740992", "2-1",
	])("拒绝无法由 schema 表达的非法连续行范围 %j", async (lines) => {
		const result = await testContext.read({ path: "missing.txt", lines });
		expect(result).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH", message: expect.stringContaining("lines") },
		});
	});

	it("文本拒绝页范围", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\n");
		expect(await testContext.read({ path: "a.txt", pages: "1" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it("拒绝非法范围、缺失文件、二进制和非法 UTF-8", async () => {
		await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(path.join(workspace, "bad.txt"), Buffer.from([0xc3, 0x28]));
		expect(await testContext.read({ path: "missing.txt" })).toMatchObject({
			status: "failed",
			error: { code: "FILE_NOT_FOUND" },
		});
		expect(await testContext.read({ path: "binary.bin" })).toMatchObject({
			status: "failed",
			error: { code: "BINARY_FILE_UNSUPPORTED" },
		});
		expect(await testContext.read({ path: "bad.txt" })).toMatchObject({
			status: "failed",
			error: { code: "ENCODING_UNSUPPORTED" },
		});
	});

	it("允许读取绝对路径、.. 相对路径和指向外部的符号链接", async () => {
		const secret = path.join(outside, "secret.txt");
		await writeFile(secret, "secret");
		await writeFile(path.join(workspace, "inside.txt"), "inside");
		const relativeOutside = path.relative(workspace, secret);
		expect(await testContext.read({ path: path.join(workspace, "inside.txt") })).toMatchObject({
			path: "inside.txt",
			content: "inside",
		});
		expect(await testContext.read({ path: relativeOutside })).toMatchObject({
			path: relativeOutside.replace(/\\/g, "/"),
			content: "secret",
		});
		expect(await testContext.read({ path: secret })).toMatchObject({
			path: path.normalize(secret),
			content: "secret",
		});
		try {
			await symlink(secret, path.join(workspace, "link.txt"));
			expect(await testContext.read({ path: "link.txt" })).toMatchObject({
				path: "link.txt",
				content: "secret",
			});
		} catch {
			// Windows 未启用符号链接权限时跳过该断言。
		}
	});

	it("blocked_path 对 lexical path 和 realpath 都生效", async () => {
		const protectedDir = path.join(outside, "protected");
		await mkdir(protectedDir);
		await writeFile(path.join(workspace, "blocked.txt"), "blocked\n");
		await writeFile(path.join(protectedDir, "secret.txt"), "secret\n");
		await testContext.useConfig({ blocked_path: ["blocked.txt", `${protectedDir}/`] });

		expect(await testContext.read({ path: "blocked.txt" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "blocked.txt" },
		});

		try {
			await symlink(path.join(protectedDir, "secret.txt"), path.join(workspace, "secret-link.txt"));
		} catch {
			return;
		}
		expect(await testContext.read({ path: "secret-link.txt" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "secret-link.txt" },
		});
	});

	it("内容变化会改变 version，read 不修改内容或 mtime", async () => {
		const file = path.join(workspace, "a.txt");
		await writeFile(file, "one\n");
		const oldDate = new Date("2020-01-01T00:00:00Z");
		await utimes(file, oldDate, oldDate);
		const first = await testContext.read({ path: "a.txt" });
		const afterReadBytes = await readFile(file);
		const afterReadStat = await stat(file);
		await writeFile(file, "two\n");
		const second = await testContext.read({ path: "a.txt" });
		expect(afterReadBytes.toString("utf8")).toBe("one\n");
		expect(afterReadStat.mtimeMs).toBeLessThan(oldDate.getTime() + 1000);
		if ("version" in first && "version" in second) expect(first.version).not.toBe(second.version);
	});
});

describe("read PDF 页面", () => {
	it("通过真实 PDF.js 路径返回页面图片、metadata、标签和版本", async () => {
		const bytes = await pdfFixture("two-page.pdf");
		await writeFile(path.join(workspace, "document.pdf"), bytes);

		const result = await testContext.read({ path: "document.pdf" });
		expect(result).toMatchObject({
			path: "document.pdf",
			media_type: "pdf",
			mime_type: "application/pdf",
			size_bytes: bytes.byteLength,
			start_page: 1,
			end_page: 2,
			total_pages: 2,
			truncated: false,
			metadata: { title: "Stage 2 PDF", author: "Pi Tests", pdf_version: "1.7" },
			pages: [
				{ number: 1, label: "i", width_points: 300, height_points: 200, image: { mime_type: "image/png" } },
				{ number: 2, label: "A-1", width_points: 300, height_points: 200, image: { mime_type: "image/png" } },
			],
		});
		if (!("status" in result)) {
			expect(result.version).toBe(sha256Version(bytes));
			if ("media_type" in result && result.media_type === "pdf") {
				for (const page of result.pages) expect(Buffer.from(page.image.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
			}
		}
	});

	it.each([
		{ pages: "2", expected: [2, 2] },
		{ pages: "2-4", expected: [2, 4] },
		{ pages: "3-", expected: [3, 5] },
		{ pages: "4-99", expected: [4, 5] },
	] as const)("按连续页范围 $pages 只渲染最终页", async ({ pages, expected }) => {
		await writeFile(path.join(workspace, "range.pdf"), await pdfFixture("two-page.pdf"));
		const fake = fakePdfSource({ pageCount: 5 });
		const result = await testContext.read({ path: "range.pdf", pages }, {
			pdf: fake.source,
			image: passthroughPdfImage,
		});
		expect(result).toMatchObject({ start_page: expected[0], end_page: expected[1], total_pages: 5, truncated: false });
		expect(fake.renderedPages).toEqual(sequence(expected[0], expected[1]));
		expect(fake.disposeCalls).toBe(1);
	});

	it("默认和显式大范围都受 read_pdf_pages 限制并返回 continuation", async () => {
		await writeFile(path.join(workspace, "many.pdf"), await pdfFixture("two-page.pdf"));
		const defaultFake = fakePdfSource({ pageCount: 25 });
		const defaultResult = await testContext.read({ path: "many.pdf" }, {
			pdf: defaultFake.source,
			image: passthroughPdfImage,
		});
		expect(defaultResult).toMatchObject({
			start_page: 1,
			end_page: 20,
			total_pages: 25,
			truncated: true,
			continuation: { start_page: 21 },
		});
		expect(defaultFake.renderedPages).toEqual(sequence(1, 20));

		await testContext.useConfig({ limits: { read_pdf_pages: 2 } });
		const configuredFake = fakePdfSource({ pageCount: 10 });
		const configuredResult = await testContext.read({ path: "many.pdf", pages: "4-9" }, {
			pdf: configuredFake.source,
			image: passthroughPdfImage,
		});
		expect(configuredResult).toMatchObject({
			start_page: 4,
			end_page: 5,
			truncated: true,
			continuation: { start_page: 6 },
		});
		expect(configuredFake.renderedPages).toEqual([4, 5]);
	});

	it("校验 PDF 范围和 API 图片能力后才打开或渲染文档", async () => {
		await writeFile(path.join(workspace, "guarded.pdf"), await pdfFixture("two-page.pdf"));
		const unsupported = fakePdfSource({ pageCount: 2 });
		expect(await testContext.read({ path: "guarded.pdf" }, {
			pdf: unsupported.source,
			supportedOutputFormats: ["text"],
		})).toMatchObject({ status: "failed", error: { code: "API_NOT_SUPPORTED" } });
		expect(unsupported.openCalls).toBe(0);

		const lines = fakePdfSource({ pageCount: 2 });
		expect(await testContext.read({ path: "guarded.pdf", lines: "1" }, { pdf: lines.source })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
		expect(lines.openCalls).toBe(0);

		const outside = fakePdfSource({ pageCount: 2 });
		expect(await testContext.read({ path: "guarded.pdf", pages: "3" }, { pdf: outside.source })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH", details: { start_page: 3, total_pages: 2 } },
		});
		expect(outside.renderedPages).toEqual([]);
		expect(outside.disposeCalls).toBe(1);
	});

	it.each([
		{ reason: "invalid-document" as const, message: "invalid PDF" },
		{ reason: "password-required" as const, message: "password required" },
	])("把 $reason 映射为带 PDF 阶段的结构化失败", async ({ reason, message }) => {
		await writeFile(path.join(workspace, "parse.pdf"), await pdfFixture("two-page.pdf"));
		const source: PdfDocumentSource = {
			async open() {
				return { ok: false, reason, message };
			},
		};
		expect(await testContext.read({ path: "parse.pdf" }, { pdf: source })).toMatchObject({
			status: "failed",
			error: {
				code: "BINARY_FILE_UNSUPPORTED",
				message,
				details: { mime_type: "application/pdf", stage: "parse", reason },
			},
		});
	});

	it("中间页渲染或图片处理失败时不返回部分结果并释放文档", async () => {
		await writeFile(path.join(workspace, "failure.pdf"), await pdfFixture("two-page.pdf"));
		const renderFailure = fakePdfSource({
			pageCount: 3,
			render(pageNumber) {
				return pageNumber === 2
					? { ok: false, reason: "render-failed", message: "page failed" }
					: renderedPdfPage(pageNumber);
			},
		});
		const failedRender = await testContext.read({ path: "failure.pdf" }, {
			pdf: renderFailure.source,
			image: passthroughPdfImage,
		});
		expect(failedRender).toMatchObject({
			status: "failed",
			error: { code: "BINARY_FILE_UNSUPPORTED", details: { stage: "render", page: 2 } },
		});
		expect(failedRender).not.toHaveProperty("pages");
		expect(renderFailure.renderedPages).toEqual([1, 2]);
		expect(renderFailure.disposeCalls).toBe(1);

		const imageFailure = fakePdfSource({ pageCount: 3 });
		const processedPages: string[] = [];
		const failedImage = await testContext.read({ path: "failure.pdf" }, {
			pdf: imageFailure.source,
			image: {
				async process(input) {
					processedPages.push(input.path);
					if (input.path.endsWith("=2")) return { ok: false, reason: "resize", mimeType: input.mimeType };
					return passthroughPdfImage.process(input);
				},
			},
		});
		expect(failedImage).toMatchObject({
			status: "failed",
			error: { code: "BINARY_FILE_UNSUPPORTED", details: { stage: "image-process", page: 2 } },
		});
		expect(processedPages).toEqual(["failure.pdf#page=1", "failure.pdf#page=2"]);
		expect(imageFailure.renderedPages).toEqual([1, 2]);
		expect(imageFailure.disposeCalls).toBe(1);
	});

	it("只在全部页面成功后记录原始 PDF 版本 observation", async () => {
		await writeFile(path.join(workspace, "observed.pdf"), await pdfFixture("two-page.pdf"));
		await writeFile(path.join(workspace, "failed.pdf"), await pdfFixture("two-page.pdf"));
		const host = new FileToolsHost();
		try {
			const successful = fakePdfSource({ pageCount: 1 });
			expect(await readWorkspaceFile(workspace, { path: "observed.pdf" }, {
				host,
				sessionId: "pdf-observation",
				pdf: successful.source,
				image: passthroughPdfImage,
			})).toMatchObject({ media_type: "pdf" });

			const failed = fakePdfSource({
				pageCount: 2,
				render(pageNumber) {
					return pageNumber === 2
						? { ok: false, reason: "render-failed", message: "failed" }
						: renderedPdfPage(pageNumber);
				},
			});
			expect(await readWorkspaceFile(workspace, { path: "failed.pdf" }, {
				host,
				sessionId: "pdf-observation",
				pdf: failed.source,
				image: passthroughPdfImage,
			})).toMatchObject({ status: "failed" });

			const opened = await host.open({ cwd: workspace, sessionId: "pdf-observation" });
			if ("status" in opened) throw new Error(opened.error.message);
			try {
				const observed = await opened.filesystem.paths.resolveExisting("observed.pdf", { expected: "file", followFinalSymlink: true });
				const unobserved = await opened.filesystem.paths.resolveExisting("failed.pdf", { expected: "file", followFinalSymlink: true });
				if (!observed.ok || !unobserved.ok) throw new Error("PDF observation fixtures were not resolved.");
				expect(opened.observation.get(observed.value)).toBeDefined();
				expect(opened.observation.get(unobserved.value)).toBeUndefined();
			} finally {
				opened.dispose();
			}
		} finally {
			host.dispose();
		}
	});

	it("取消后不处理后续页面且始终释放文档", async () => {
		await writeFile(path.join(workspace, "cancel.pdf"), await pdfFixture("two-page.pdf"));
		const controller = new AbortController();
		const fake = fakePdfSource({ pageCount: 4 });
		const processed: number[] = [];
		const result = await testContext.read({ path: "cancel.pdf" }, {
			signal: controller.signal,
			pdf: fake.source,
			image: {
				async process(input) {
					const page = Number(input.path.split("=").at(-1));
					processed.push(page);
					if (page === 2) controller.abort();
					return passthroughPdfImage.process(input);
				},
			},
		});
		expect(result).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		expect(processed).toEqual([1, 2]);
		expect(fake.renderedPages).toEqual([1, 2]);
		expect(fake.disposeCalls).toBe(1);
	});
});

describe("PDF.js 文档端口", () => {
	it("读取页数、规范化 metadata 和页面标签，并逐页渲染 PNG", async () => {
		const document = await openFixturePdf("two-page.pdf");
		try {
			expect(document.pageCount).toBe(2);
			expect(document.metadata).toEqual({
				title: "Stage 2 PDF",
				author: "Pi Tests",
				subject: "PDF port fixture",
				keywords: "pdf test",
				creator: "fixture generator",
				producer: "o-pi",
				creationDate: "D:20260823000000Z",
				modificationDate: "D:20260823000000Z",
				pdfVersion: "1.7",
			});
			expect(document.pageLabels).toEqual(["i", "A-1"]);

			for (const pageNumber of [1, 2]) {
				const rendered = await document.renderPage({ pageNumber });
				expect(rendered).toMatchObject({
					ok: true,
					value: {
						widthPoints: 300,
						heightPoints: 200,
						rotation: 0,
						mimeType: "image/png",
					},
				});
				if (rendered.ok) {
					const png = Buffer.from(rendered.value.bytes);
					expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
					expect(png.readUInt32BE(16)).toBe(600);
					expect(png.readUInt32BE(20)).toBe(400);
				}
			}
		} finally {
			await document.dispose();
		}
	});

	it("把预取消、无效文档和密码文档返回为稳定失败", async () => {
		const source = createPdfDocumentSource();
		const controller = new AbortController();
		controller.abort();
		expect(await source.open({ bytes: await pdfFixture("two-page.pdf"), signal: controller.signal })).toMatchObject({
			ok: false,
			reason: "aborted",
		});
		expect(await source.open({ bytes: Buffer.from("not a PDF") })).toMatchObject({
			ok: false,
			reason: "invalid-document",
		});
		expect(await source.open({ bytes: await pdfFixture("password.pdf") })).toMatchObject({
			ok: false,
			reason: "password-required",
		});
	});

	it("文档可重复释放、释放后拒绝渲染并限制超大页面尺寸", async () => {
		const document = await openFixturePdf("two-page.pdf");
		await document.dispose();
		await document.dispose();
		await expect(document.renderPage({ pageNumber: 1 })).rejects.toThrow("PDF document has been disposed.");

		const hugePage = await openFixturePdf("huge-page.pdf");
		try {
			const rendered = await hugePage.renderPage({ pageNumber: 1 });
			expect(rendered).toMatchObject({
				ok: true,
				value: { widthPoints: 1_000_000_000, heightPoints: 500_000_000 },
			});
			if (rendered.ok) {
				const png = Buffer.from(rendered.value.bytes);
				expect(png.readUInt32BE(16)).toBe(2_000);
				expect(png.readUInt32BE(20)).toBe(1_000);
			}
		} finally {
			await hugePage.dispose();
		}
	});

	it("页面渲染调用取消时不返回页面图片", async () => {
		const document = await openFixturePdf("two-page.pdf");
		try {
			const controller = new AbortController();
			const rendered = document.renderPage({ pageNumber: 1, signal: controller.signal });
			controller.abort();
			expect(await rendered).toMatchObject({ ok: false, reason: "aborted" });
		} finally {
			await document.dispose();
		}
	});
});

interface FakePdfOptions {
	readonly pageCount: number;
	readonly render?: (pageNumber: number) => PdfPageRenderResult;
}

function fakePdfSource(options: FakePdfOptions): {
	readonly source: PdfDocumentSource;
	readonly renderedPages: number[];
	readonly openCalls: number;
	readonly disposeCalls: number;
} {
	const state = {
		renderedPages: [] as number[],
		openCalls: 0,
		disposeCalls: 0,
	};
	const source: PdfDocumentSource = {
		async open() {
			state.openCalls += 1;
			return {
				ok: true,
				value: {
					pageCount: options.pageCount,
					metadata: { title: "Fake PDF", author: "Tests" },
					pageLabels: Array.from({ length: options.pageCount }, (_, index) => String(index + 1)),
					async renderPage({ pageNumber }) {
						state.renderedPages.push(pageNumber);
						return options.render?.(pageNumber) ?? renderedPdfPage(pageNumber);
					},
					async dispose() {
						state.disposeCalls += 1;
					},
				},
			};
		},
	};
	return {
		source,
		get renderedPages() { return state.renderedPages; },
		get openCalls() { return state.openCalls; },
		get disposeCalls() { return state.disposeCalls; },
	};
}

function renderedPdfPage(pageNumber: number): PdfPageRenderResult {
	return {
		ok: true,
		value: {
			widthPoints: 300,
			heightPoints: 200,
			rotation: 0,
			bytes: Buffer.from(`page-${pageNumber}`),
			mimeType: "image/png",
		},
	};
}

const passthroughPdfImage: InlineImageProcessor = {
	async process(input) {
		return {
			ok: true,
			value: { data: Buffer.from(input.bytes).toString("base64"), mimeType: input.mimeType, hints: [] },
		};
	},
};

function sequence(start: number, end: number): number[] {
	return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

async function openFixturePdf(name: string): Promise<PdfDocumentHandle> {
	const opened = await createPdfDocumentSource().open({ bytes: await pdfFixture(name) });
	if (!opened.ok) throw new Error(`Could not open PDF fixture ${name}: ${opened.reason}`);
	return opened.value;
}

async function pdfFixture(name: string): Promise<Buffer> {
	return await readFile(new URL(`./fixtures/read/${name}`, import.meta.url));
}
