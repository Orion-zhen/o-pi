import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.js";
import type { FailedResult, NewlineKind, TextFile, ToolOutcome } from "./types.js";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2_000;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** 对原始字节计算版本，避免 mtime/size 造成并发误判。 */
export function sha256Version(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 按 UTF-8 严格读取文本文件；二进制和非法编码会失败。 */
export async function readTextFile(absolutePath: string, relativePath: string): Promise<ToolOutcome<TextFile>> {
	let bytes: Buffer;
	try {
		bytes = await readFile(absolutePath);
	} catch {
		return fail("FILE_NOT_FOUND", "File does not exist.", { path: relativePath });
	}
	return decodeTextFile(bytes, relativePath);
}

export function decodeTextFile(bytes: Buffer, relativePath: string): ToolOutcome<TextFile> {
	if (bytes.includes(0)) {
		return fail("BINARY_FILE_UNSUPPORTED", "Binary files are not supported.", { path: relativePath });
	}

	const hasBom = bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM);
	const payload = hasBom ? bytes.subarray(3) : bytes;
	let text: string;
	try {
		text = textDecoder.decode(payload);
	} catch {
		return fail("ENCODING_UNSUPPORTED", "Only valid UTF-8 text is supported.", { path: relativePath });
	}

	return {
		bytes,
		text,
		version: sha256Version(bytes),
		sizeBytes: bytes.byteLength,
		totalLines: countLogicalLines(text),
		newline: detectNewline(text),
		hasBom,
	};
}

/** 按逻辑行切片，同时保留被返回行本身的原始换行符。 */
export function sliceTextByLineRange(
	file: TextFile,
	startLine: number | undefined,
	endLine: number | undefined,
	relativePath: string,
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
	if (file.totalLines === 0) {
		return { content: "", startLine: 1, endLine: 0, truncated: false };
	}

	const requestedStart = startLine ?? 1;
	const requestedEnd = endLine ?? file.totalLines;
	if (requestedStart > file.totalLines) {
		return fail("INVALID_PATH", "start_line is beyond the end of the file.", { path: relativePath });
	}
	if (requestedEnd > file.totalLines) {
		return fail("INVALID_PATH", "end_line is beyond the end of the file.", { path: relativePath });
	}

	const records = lineRecords(file.text);
	const selected: string[] = [];
	let outputBytes = 0;
	let outputLines = 0;
	let nextLine: number | undefined;

	for (let line = requestedStart; line <= requestedEnd; line += 1) {
		const record = records[line - 1];
		if (record === undefined) break;
		const recordBytes = Buffer.byteLength(record, "utf8");
		if (recordBytes > MAX_OUTPUT_BYTES) {
			return fail("OUTPUT_LIMIT_EXCEEDED", "A single line exceeds the read output limit.", { path: relativePath });
		}
		if (outputLines >= MAX_OUTPUT_LINES || outputBytes + recordBytes > MAX_OUTPUT_BYTES) {
			nextLine = line;
			break;
		}
		selected.push(record);
		outputBytes += recordBytes;
		outputLines += 1;
	}

	const actualEnd = requestedStart + outputLines - 1;
	if (nextLine !== undefined) {
		return {
			content: selected.join(""),
			startLine: requestedStart,
			endLine: outputLines === 0 ? requestedStart - 1 : actualEnd,
			truncated: true,
			continuation: { start_line: nextLine },
		};
	}
	return {
		content: selected.join(""),
		startLine: requestedStart,
		endLine: outputLines === 0 ? requestedStart - 1 : actualEnd,
		truncated: false,
	};
}

export function logicalLines(text: string): { lines: string[]; finalNewline: boolean } {
	if (text === "") return { lines: [], finalNewline: false };
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const finalNewline = normalized.endsWith("\n");
	const parts = normalized.split("\n");
	if (finalNewline) parts.pop();
	return { lines: parts, finalNewline };
}

export function buildTextBytes(text: string, hasBom: boolean): Buffer {
	const body = Buffer.from(text, "utf8");
	return hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

export function joinLogicalLines(lines: string[], newline: string, finalNewline: boolean): string {
	if (lines.length === 0) return "";
	const body = lines.join(newline);
	return finalNewline ? `${body}${newline}` : body;
}

/** 同目录临时文件 + rename；调用方负责事务级回滚。 */
export async function writeFileAtomic(targetPath: string, bytes: Buffer, mode?: number): Promise<void> {
	const dir = path.dirname(targetPath);
	const name = `.pi-edit-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}.tmp`;
	const tempPath = path.join(dir, name);
	let created = false;

	try {
		const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode ?? 0o666);
		created = true;
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (mode !== undefined) {
			await import("node:fs/promises").then((fs) => fs.chmod(tempPath, mode));
		}
		await rename(tempPath, targetPath);
		created = false;
	} finally {
		if (created) {
			await unlink(tempPath).catch(() => undefined);
		}
	}
}

function countLogicalLines(text: string): number {
	return logicalLines(text).lines.length;
}

function detectNewline(text: string): NewlineKind {
	let lf = 0;
	let crlf = 0;
	let bareCr = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === "\r") {
			if (text[index + 1] === "\n") {
				crlf += 1;
				index += 1;
			} else {
				bareCr += 1;
			}
		} else if (char === "\n") {
			lf += 1;
		}
	}
	if (lf === 0 && crlf === 0 && bareCr === 0) return "none";
	if (bareCr > 0) return "mixed";
	if (lf > 0 && crlf > 0) return "mixed";
	return crlf > 0 ? "crlf" : "lf";
}

function lineRecords(text: string): string[] {
	if (text === "") return [];
	const records: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\r" && text[index + 1] === "\n") {
			records.push(text.slice(start, index + 2));
			index += 1;
			start = index + 1;
		} else if (text[index] === "\n" || text[index] === "\r") {
			records.push(text.slice(start, index + 1));
			start = index + 1;
		}
	}
	if (start < text.length) records.push(text.slice(start));
	return records;
}
