import type { FileSnapshot } from "./metadata.js";
import type { FileRef } from "./path.js";
import type { FsResult } from "./result.js";

export type NewlineKind = "lf" | "crlf" | "mixed" | "none";

export interface ContentVersion {
	readonly hash: string;
	readonly sizeBytes: number;
}

export interface ByteContent extends ContentVersion {
	readonly bytes: Uint8Array;
}

export interface TextContent extends ByteContent {
	readonly text: string;
	readonly totalLines: number;
	readonly newline: NewlineKind;
	readonly hasBom: boolean;
}

export interface ReadOptions {
	readonly maxBytes?: number;
	/** Requires the opened file to equal this caller-captured snapshot before reading begins. */
	readonly expectedSnapshot?: FileSnapshot;
}

export interface TextByteRange {
	/** 已解码正文中的 UTF-8 byte 起点，包含该位置。 */
	readonly startByte: number;
	/** 已解码正文中的 UTF-8 byte 终点，不包含该位置。 */
	readonly endByte: number;
}

export interface TextLineRange extends TextByteRange {
	/** 逻辑行号从 1 开始且两端均包含；byte 范围包含末行存在的行终止符。 */
	readonly startLine: number;
	readonly endLine: number;
}

export interface TextRangeInput {
	readonly startLine: number;
	readonly endLine: number;
	/** byte 起止位置必须同时提供或同时省略。 */
	readonly startByte?: number;
	readonly endByte?: number;
}

export interface ScannedLine {
	readonly line: number;
	/** Logical line text without its line terminator. */
	readonly text: string;
	/** 相对已解码 TextContent.text 的 UTF-8 位置，不包含 BOM 和行终止符。 */
	readonly byteStart: number;
	readonly byteEnd: number;
}

export interface TextSliceOptions {
	readonly startLine?: number;
	readonly endLine?: number;
	readonly maxBytes: number;
	readonly maxLines: number;
	readonly path: string;
}

export interface TextSlice {
	readonly content: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly truncated: boolean;
	readonly continuation?: { readonly startLine: number };
}

export interface LineScan extends AsyncIterable<FsResult<ScannedLine>> {
	close(): Promise<void>;
}

export interface ContentOperations {
	readBytes(file: FileRef, options: ReadOptions): Promise<FsResult<ByteContent>>;
	readText(file: FileRef, options: ReadOptions): Promise<FsResult<TextContent>>;
	/** Decodes bytes already loaded through this filesystem without a second disk read. */
	decodeText(content: ByteContent, path: string): FsResult<TextContent>;
	sliceText(content: TextContent, options: TextSliceOptions): FsResult<TextSlice>;
	scanLines(file: FileRef, options: ReadOptions): Promise<FsResult<LineScan>>;
}
