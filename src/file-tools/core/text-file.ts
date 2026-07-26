import { readFile } from "node:fs/promises";

import type { TextContent } from "../../filesystem/contracts/content.js";
import {
	buildTextBytes as buildFilesystemTextBytes,
	contentHash,
	decodeUtf8,
	describeText,
	logicalLines as filesystemLogicalLines,
	normalizeLineEndings as normalizeFilesystemLineEndings,
	sliceTextByLineRange as sliceFilesystemText,
} from "../../filesystem/services/text.js";
import { fail, type ToolOutcome } from "../shared/result.js";
import type { TextFile } from "../types.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
export const DEFAULT_MAX_OUTPUT_LINES = 2_000;

export function normalizeLineEndings(text: string): string {
	return normalizeFilesystemLineEndings(text);
}

/** 对原始字节计算版本，避免 mtime/size 造成并发误判。 */
export function sha256Version(bytes: Buffer): string {
	return contentHash(bytes);
}

/** 按 UTF-8 严格读取文本文件；二进制和非法编码会失败。 */
export async function readTextFile(absolutePath: string, relativePath: string): Promise<ToolOutcome<TextFile>> {
	const bytes = await readRawFile(absolutePath, relativePath);
	if ("status" in bytes) return bytes;
	return decodeTextFile(bytes, relativePath);
}

export async function readRawFile(absolutePath: string, relativePath: string): Promise<ToolOutcome<Buffer>> {
	let bytes: Buffer;
	try {
		bytes = await readFile(absolutePath);
	} catch {
		return fail("FILE_NOT_FOUND", "File does not exist.", { path: relativePath });
	}
	return bytes;
}

export function decodeTextFile(bytes: Buffer, relativePath: string): ToolOutcome<TextFile> {
	const decoded = decodeUtf8Text(bytes, relativePath);
	if (typeof decoded !== "string") return decoded;
	return {
		bytes,
		text: decoded,
		version: contentHash(bytes),
		sizeBytes: bytes.byteLength,
		...describeText(bytes, decoded),
	};
}

/** grep 等扫描器只需要严格 UTF-8 正文，不支付版本、行数和换行统计成本。 */
export function decodeUtf8Text(bytes: Buffer, relativePath: string): ToolOutcome<string> {
	const decoded = decodeUtf8(bytes, { rejectBinary: true, path: relativePath });
	if (decoded.ok) return decoded.value;
	if (decoded.error.code === "binary") {
		return fail("BINARY_FILE_UNSUPPORTED", "Binary files are not supported.", { path: relativePath });
	}
	return fail("ENCODING_UNSUPPORTED", "Only valid UTF-8 text is supported.", { path: relativePath });
}

/** 按逻辑行切片，同时保留被返回行本身的原始换行符。 */
export function sliceTextByLineRange(
	file: TextFile,
	startLine: number | undefined,
	endLine: number | undefined,
	relativePath: string,
	limits: { maxBytes: number; maxLines: number } = {
		maxBytes: DEFAULT_MAX_OUTPUT_BYTES,
		maxLines: DEFAULT_MAX_OUTPUT_LINES,
	},
): ToolOutcome<{
	content: string;
	startLine: number;
	endLine: number;
	truncated: boolean;
	continuation?: { start_line: number };
}> {
	if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
		return fail("INVALID_PATH", "start_line must be a positive integer.", { path: relativePath });
	}
	if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
		return fail("INVALID_PATH", "end_line must be a positive integer.", { path: relativePath });
	}
	if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
		return fail("INVALID_PATH", "start_line must be less than or equal to end_line.", { path: relativePath });
	}
	const filesystemFile: TextContent = {
		bytes: file.bytes,
		text: file.text,
		hash: file.version,
		sizeBytes: file.sizeBytes,
		totalLines: file.totalLines,
		newline: file.newline,
		hasBom: file.hasBom,
	};
	const sliced = sliceFilesystemText(filesystemFile, {
		...(startLine === undefined ? {} : { startLine }),
		...(endLine === undefined ? {} : { endLine }),
		maxBytes: limits.maxBytes,
		maxLines: limits.maxLines,
		path: relativePath,
	});
	if (!sliced.ok) {
		if (sliced.error.code === "too-large") {
			return fail("OUTPUT_LIMIT_EXCEEDED", "A single line exceeds the read output limit.", { path: relativePath });
		}
		return fail("INVALID_PATH", "start_line is beyond the end of the file.", { path: relativePath });
	}
	return {
		content: sliced.value.content,
		startLine: sliced.value.startLine,
		endLine: sliced.value.endLine,
		truncated: sliced.value.truncated,
		...(sliced.value.continuation === undefined
			? {}
			: { continuation: { start_line: sliced.value.continuation.startLine } }),
	};
}

export function logicalLines(text: string): { lines: string[]; finalNewline: boolean } {
	const result = filesystemLogicalLines(text);
	return { lines: [...result.lines], finalNewline: result.finalNewline };
}

export function buildTextBytes(text: string, hasBom: boolean): Buffer {
	return Buffer.from(buildFilesystemTextBytes(text, hasBom));
}
