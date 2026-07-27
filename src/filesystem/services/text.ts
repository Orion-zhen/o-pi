import { createHash } from "node:crypto";

import type {
	NewlineKind,
	TextContent,
	TextLineRange,
	TextRangeInput,
	TextSlice,
	TextSliceOptions,
} from "../contracts/content.js";
import { fsFailure, fsSuccess, type FsResult } from "../contracts/result.js";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const encoder = new TextEncoder();

export function contentHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function decodeUtf8(bytes: Uint8Array, options: { readonly rejectBinary: boolean; readonly path?: string }): FsResult<string> {
	if (options.rejectBinary && bytes.includes(0)) {
		return fsFailure({ code: "binary", message: "Binary content is not supported.", ...errorPath(options.path) });
	}
	const payload = hasUtf8Bom(bytes) ? bytes.subarray(UTF8_BOM.byteLength) : bytes;
	try {
		return fsSuccess(new TextDecoder("utf-8", { fatal: true }).decode(payload));
	} catch {
		return fsFailure({ code: "invalid-utf8", message: "Content is not valid UTF-8.", ...errorPath(options.path) });
	}
}

export function describeText(bytes: Uint8Array, text: string): Pick<TextContent, "totalLines" | "newline" | "hasBom"> {
	return {
		totalLines: logicalLines(text).lines.length,
		newline: detectNewline(text),
		hasBom: hasUtf8Bom(bytes),
	};
}

export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export function logicalLines(text: string): { readonly lines: readonly string[]; readonly finalNewline: boolean } {
	if (text === "") return { lines: [], finalNewline: false };
	const normalized = normalizeLineEndings(text);
	const finalNewline = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (finalNewline) lines.pop();
	return { lines, finalNewline };
}

export function buildTextBytes(text: string, hasBom: boolean): Uint8Array {
	const body = encoder.encode(text);
	if (!hasBom) return body;
	const bytes = new Uint8Array(UTF8_BOM.byteLength + body.byteLength);
	bytes.set(UTF8_BOM);
	bytes.set(body, UTF8_BOM.byteLength);
	return bytes;
}

/** 将合法 UTF-16 code-unit 边界转换为正文 UTF-8 byte 位置。 */
export function utf8ByteOffset(text: string, codeUnitOffset: number): number | undefined {
	if (!Number.isSafeInteger(codeUnitOffset) || codeUnitOffset < 0 || codeUnitOffset > text.length) return undefined;
	if (splitsSurrogatePair(text, codeUnitOffset)) return undefined;
	return encoder.encode(text.slice(0, codeUnitOffset)).byteLength;
}

/** 将从 1 开始且两端包含的逻辑行范围转换为正文 UTF-8 坐标。 */
export function byteRangeForLines(text: string, startLine: number, endLine: number): TextLineRange | undefined {
	if (!positiveInteger(startLine) || !positiveInteger(endLine) || endLine < startLine) return undefined;
	const ranges = logicalLineCodeUnitRanges(text);
	const start = ranges[startLine - 1];
	const end = ranges[endLine - 1];
	if (start === undefined || end === undefined) return undefined;
	const startByte = utf8ByteOffset(text, start.start);
	const endByte = utf8ByteOffset(text, end.end);
	if (startByte === undefined || endByte === undefined) return undefined;
	return { startLine, endLine, startByte, endByte };
}

/** 根据声明的逻辑行范围补全并验证可选 byte 坐标。 */
export function resolveTextRange(text: string, input: TextRangeInput): TextLineRange | undefined {
	const lines = byteRangeForLines(text, input.startLine, input.endLine);
	if (lines === undefined || (input.startByte === undefined) !== (input.endByte === undefined)) return undefined;
	if (input.startByte === undefined || input.endByte === undefined) return lines;
	if (!nonNegativeInteger(input.startByte) || !nonNegativeInteger(input.endByte)
		|| input.endByte < input.startByte
		|| input.startByte < lines.startByte || input.endByte > lines.endByte
		|| !isUtf8ByteBoundary(text, input.startByte) || !isUtf8ByteBoundary(text, input.endByte)) return undefined;
	return { ...lines, startByte: input.startByte, endByte: input.endByte };
}

/** 仅在起止位置都是合法正文 UTF-8 边界时提取精确 byte 范围。 */
export function extractByteRange(text: string, startByte: number, endByte: number): string | undefined {
	if (!nonNegativeInteger(startByte) || !nonNegativeInteger(endByte) || endByte < startByte) return undefined;
	const bytes = encoder.encode(text);
	if (endByte > bytes.byteLength || !utf8Boundary(bytes, startByte) || !utf8Boundary(bytes, endByte)) return undefined;
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(startByte, endByte));
}

/** Slices logical lines while preserving each selected line's original terminator. */
export function sliceTextByLineRange(file: TextContent, options: TextSliceOptions): FsResult<TextSlice> {
	const validation = validateSliceOptions(options);
	if (validation !== undefined) return fsFailure(validation);
	if (file.totalLines === 0) return fsSuccess({ content: "", startLine: 1, endLine: 0, truncated: false });

	const requestedStart = options.startLine ?? 1;
	if (requestedStart > file.totalLines) {
		return fsFailure({
			code: "invalid-path",
			message: "Start line is beyond the end of the file.",
			...errorPath(options.path),
		});
	}
	const requestedEnd = Math.min(options.endLine ?? file.totalLines, file.totalLines);
	const records = lineRecords(file.text);
	const selected: string[] = [];
	let outputBytes = 0;
	let nextLine: number | undefined;

	for (let line = requestedStart; line <= requestedEnd; line += 1) {
		const record = records[line - 1];
		if (record === undefined) break;
		const recordBytes = encoder.encode(record).byteLength;
		if (recordBytes > options.maxBytes) {
			return fsFailure({
				code: "too-large",
				message: "A single line exceeds the output limit.",
				...errorPath(options.path),
			});
		}
		if (selected.length >= options.maxLines || outputBytes + recordBytes > options.maxBytes) {
			nextLine = line;
			break;
		}
		selected.push(record);
		outputBytes += recordBytes;
	}

	const endLine = selected.length === 0 ? requestedStart - 1 : requestedStart + selected.length - 1;
	return fsSuccess({
		content: selected.join(""),
		startLine: requestedStart,
		endLine,
		truncated: nextLine !== undefined,
		...(nextLine === undefined ? {} : { continuation: { startLine: nextLine } }),
	});
}

export function hasUtf8Bom(bytes: Uint8Array): boolean {
	return bytes.byteLength >= UTF8_BOM.byteLength
		&& bytes[0] === UTF8_BOM[0]
		&& bytes[1] === UTF8_BOM[1]
		&& bytes[2] === UTF8_BOM[2];
}

function logicalLineCodeUnitRanges(text: string): readonly { readonly start: number; readonly end: number }[] {
	if (text.length === 0) return [];
	const ranges: Array<{ readonly start: number; readonly end: number }> = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "\r" && text[index] !== "\n") continue;
		const terminatorEnd = text[index] === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
		ranges.push({ start, end: terminatorEnd });
		if (terminatorEnd < text.length) start = terminatorEnd;
		else start = text.length;
		index = terminatorEnd - 1;
	}
	if (start < text.length) ranges.push({ start, end: text.length });
	return ranges;
}

function isUtf8ByteBoundary(text: string, offset: number): boolean {
	const bytes = encoder.encode(text);
	return offset <= bytes.byteLength && utf8Boundary(bytes, offset);
}

function utf8Boundary(bytes: Uint8Array, offset: number): boolean {
	return offset === 0 || offset === bytes.byteLength || (bytes[offset] !== undefined && (bytes[offset] & 0xc0) !== 0x80);
}

function splitsSurrogatePair(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return false;
	const previous = text.charCodeAt(offset - 1);
	const current = text.charCodeAt(offset);
	return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function detectNewline(text: string): NewlineKind {
	let lf = 0;
	let crlf = 0;
	let bareCr = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\r") {
			if (text[index + 1] === "\n") {
				crlf += 1;
				index += 1;
			} else bareCr += 1;
		} else if (text[index] === "\n") lf += 1;
	}
	if (lf === 0 && crlf === 0 && bareCr === 0) return "none";
	if (bareCr > 0 || (lf > 0 && crlf > 0)) return "mixed";
	return crlf > 0 ? "crlf" : "lf";
}

function lineRecords(text: string): readonly string[] {
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

function validateSliceOptions(options: TextSliceOptions): { code: "invalid-path"; message: string; path?: string } | undefined {
	if (options.startLine !== undefined && (!Number.isInteger(options.startLine) || options.startLine < 1)) {
		return { code: "invalid-path", message: "Start line must be a positive integer.", ...errorPath(options.path) };
	}
	if (options.endLine !== undefined && (!Number.isInteger(options.endLine) || options.endLine < 1)) {
		return { code: "invalid-path", message: "End line must be a positive integer.", ...errorPath(options.path) };
	}
	if (options.startLine !== undefined && options.endLine !== undefined && options.startLine > options.endLine) {
		return { code: "invalid-path", message: "Start line must not exceed end line.", ...errorPath(options.path) };
	}
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
		|| !Number.isSafeInteger(options.maxLines) || options.maxLines < 1) {
		return { code: "invalid-path", message: "Text limits must be positive integers.", ...errorPath(options.path) };
	}
	return undefined;
}

function errorPath(path: string | undefined): { readonly path?: string } {
	return path === undefined ? {} : { path };
}
