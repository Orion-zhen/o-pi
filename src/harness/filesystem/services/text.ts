import { createHash } from "node:crypto";

import type {
	NewlineKind,
	ScannedLine,
	TextContent,
	TextSlice,
	TextSliceOptions,
} from "../contracts/content.js";
import { fsFailure, fsSuccess, type FsResult } from "../contracts/result.js";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const encoder = new TextEncoder();

export function contentHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function decodeUtf8(bytes: Uint8Array, path: string): FsResult<string> {
	if (bytes.includes(0)) {
		return fsFailure({ code: "binary", message: "Binary content is not supported.", path });
	}
	const payload = hasUtf8Bom(bytes) ? bytes.subarray(UTF8_BOM.byteLength) : bytes;
	try {
		return fsSuccess(new TextDecoder("utf-8", { fatal: true }).decode(payload));
	} catch {
		return fsFailure({ code: "invalid-utf8", message: "Content is not valid UTF-8.", path });
	}
}

export function describeText(bytes: Uint8Array, text: string): Pick<TextContent, "totalLines" | "newline" | "hasBom"> {
	let totalLines = 0;
	let hasLf = false;
	let hasCrlf = false;
	let hasBareCr = false;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\r") {
			totalLines += 1;
			if (text[index + 1] === "\n") {
				hasCrlf = true;
				index += 1;
			} else hasBareCr = true;
		} else if (text[index] === "\n") {
			totalLines += 1;
			hasLf = true;
		}
	}
	if (text.length > 0 && text[text.length - 1] !== "\r" && text[text.length - 1] !== "\n") totalLines += 1;

	let newline: NewlineKind = "none";
	if (hasBareCr || (hasLf && hasCrlf)) newline = "mixed";
	else if (hasCrlf) newline = "crlf";
	else if (hasLf) newline = "lf";
	return { totalLines, newline, hasBom: hasUtf8Bom(bytes) };
}

/** 在已稳定读取的正文上复用 streaming scan 的 logical-line 与 UTF-8 坐标语义。 */
export function* scannedTextLines(text: string): Generator<ScannedLine> {
	if (text.length === 0) return;
	let line = 1;
	let startChar = 0;
	let startByte = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char !== "\r" && char !== "\n") continue;
		const terminatorChars = char === "\r" && text[index + 1] === "\n" ? 2 : 1;
		const lineText = text.slice(startChar, index);
		const byteLength = encoder.encode(lineText).byteLength;
		yield {
			line,
			text: lineText,
			byteStart: startByte,
			byteEnd: startByte + byteLength,
		};
		line += 1;
		startChar = index + terminatorChars;
		startByte += byteLength + terminatorChars;
		index += terminatorChars - 1;
	}
	if (startChar < text.length) {
		const lineText = text.slice(startChar);
		yield {
			line,
			text: lineText,
			byteStart: startByte,
			byteEnd: startByte + encoder.encode(lineText).byteLength,
		};
	}
}

/** 将合法 UTF-16 code-unit 边界转换为正文 UTF-8 byte 位置。 */
export function utf8ByteOffset(text: string, codeUnitOffset: number): number | undefined {
	if (!Number.isSafeInteger(codeUnitOffset) || codeUnitOffset < 0 || codeUnitOffset > text.length) return undefined;
	if (splitsSurrogatePair(text, codeUnitOffset)) return undefined;
	return encoder.encode(text.slice(0, codeUnitOffset)).byteLength;
}

/** Slices logical lines while preserving each selected line's original terminator. */
export function sliceTextByLineRange(file: TextContent, options: TextSliceOptions): FsResult<TextSlice> {
	if (file.totalLines === 0) return fsSuccess({ content: "", startLine: 1, endLine: 0, truncated: false });

	const requestedStart = options.startLine ?? 1;
	if (requestedStart > file.totalLines) {
		return fsFailure({
			code: "invalid-path",
			message: "Start line is beyond the end of the file.",
			path: options.path,
		});
	}
	const requestedEnd = Math.min(options.endLine ?? file.totalLines, file.totalLines);
	let recordStart = 0;
	for (let line = 1; line < requestedStart; line += 1) {
		recordStart = lineRecordEnd(file.text, recordStart);
	}

	const selectedStart = recordStart;
	let selectedEnd = recordStart;
	let selectedLines = 0;
	let outputBytes = 0;
	let nextLine: number | undefined;

	for (let line = requestedStart; line <= requestedEnd; line += 1) {
		if (selectedLines >= options.maxLines || outputBytes === options.maxBytes) {
			nextLine = line;
			break;
		}
		const recordEnd = lineRecordEnd(file.text, recordStart);
		const recordBytes = encoder.encode(file.text.slice(recordStart, recordEnd)).byteLength;
		if (recordBytes > options.maxBytes) {
			return fsFailure({
				code: "too-large",
				message: "A single line exceeds the output limit.",
				path: options.path,
			});
		}
		if (outputBytes + recordBytes > options.maxBytes) {
			nextLine = line;
			break;
		}
		selectedEnd = recordEnd;
		selectedLines += 1;
		outputBytes += recordBytes;
		recordStart = recordEnd;
	}

	const endLine = selectedLines === 0 ? requestedStart - 1 : requestedStart + selectedLines - 1;
	return fsSuccess({
		content: file.text.slice(selectedStart, selectedEnd),
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

function splitsSurrogatePair(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return false;
	const previous = text.charCodeAt(offset - 1);
	const current = text.charCodeAt(offset);
	return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

function lineRecordEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index += 1) {
		if (text[index] === "\r") return text[index + 1] === "\n" ? index + 2 : index + 1;
		if (text[index] === "\n") return index + 1;
	}
	return text.length;
}
