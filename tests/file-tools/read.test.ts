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

import { WorkspaceContentService } from "../../src/filesystem/services/content.js";
import { contentHash as sha256Version } from "../../src/filesystem/services/text.js";
import { formatReadStructureContext } from "../../src/file-tools/read/presenter.js";
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

		expect(await testContext.read({ path: "pixel.gif", start_line: 1 })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it("图片转换异常返回结构化失败，取消仍优先返回 OPERATION_ABORTED", async () => {
		const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
		await writeFile(path.join(workspace, "pixel.gif"), imageBytes);

		const conversionFailure = await testContext.read({ path: "pixel.gif" }, {
			image: {
				async process() {
					throw new Error("simulated image conversion failure");
				},
			},
		});
		expect(conversionFailure).toMatchObject({
			status: "failed",
			error: {
				code: "BINARY_FILE_UNSUPPORTED",
				message: "Image cannot be converted to an inline model-supported format.",
				details: { mime_type: "image/gif" },
			},
		});

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
		expect(await testContext.read({ path: "oversized.txt", start_line: 1, end_line: 1 })).toMatchObject({
			status: "failed",
			error: {
				code: "OUTPUT_LIMIT_EXCEEDED",
				path: "oversized.txt",
				details: { limit: 1024, size: 1025 },
			},
		});
	});

	it("按行范围读取且不把行号写进 content", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\n", "utf8");
		const result = await testContext.read({ path: "a.txt", start_line: 2, end_line: 2 });
		expect(result).toMatchObject({ content: "two\n", start_line: 2, end_line: 2, total_lines: 3 });
	});

	it("end_line 超过文件末尾时读取到文件末尾", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\n", "utf8");
		const result = await testContext.read({ path: "a.txt", start_line: 2, end_line: 99 });
		expect(result).toMatchObject({
			content: "two\nthree\n",
			start_line: 2,
			end_line: 3,
			total_lines: 3,
			truncated: false,
		});
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
		const sliceText = vi.spyOn(WorkspaceContentService.prototype, "sliceText");
		try {
			const truncated = await testContext.read({ path: "structured.ts" });
			expect(truncated).toMatchObject({ truncated: true, continuation: { start_line: 3 } });
			expect(sliceText).toHaveBeenCalledTimes(1);

			sliceText.mockClear();
			const partial = await testContext.read({ path: "structured.ts", start_line: 2, end_line: 2 });
			expect(partial).toMatchObject({ content: "two\n", start_line: 2, end_line: 2 });
			expect(sliceText).toHaveBeenCalledTimes(1);

			sliceText.mockClear();
			const oversized = await testContext.read({ path: "structured.ts", start_line: 2, end_line: 2 }, {
				structure: {
					async context() {
						return { enclosing_symbol: { name: "x".repeat(1024), kind: "function", line: 1, end_line: 3 } };
					},
				},
			});
			expect(oversized).not.toHaveProperty("lsp");
			expect(sliceText).toHaveBeenCalledTimes(1);

			sliceText.mockClear();
			const fitting = await testContext.read({ path: "structured.ts", start_line: 2, end_line: 2 }, {
				structure: {
					async context() {
						return { enclosing_symbol: { name: "demo", kind: "function", line: 1, end_line: 3 } };
					},
				},
			});
			expect(fitting).toMatchObject({ lsp: { enclosing_symbol: { name: "demo" } } });
			expect(sliceText).toHaveBeenCalledTimes(2);
		} finally {
			sliceText.mockRestore();
		}
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
		expect(await testContext.read({ path: "bad.txt", start_line: 2, end_line: 1 })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
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
