import type { FileRef } from "./path.js";
import type { FsOperationContext, FsResult } from "./result.js";

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

export interface ByteReadOptions {
	readonly maxBytes?: number;
	readonly stable?: boolean;
}

export interface TextReadOptions extends ByteReadOptions {
	readonly rejectBinary?: boolean;
}

export interface ScannedLine {
	readonly line: number;
	readonly text: string;
	readonly byteStart: number;
	readonly byteEnd: number;
}

export interface LineScan extends AsyncIterable<FsResult<ScannedLine>> {
	close(): Promise<void>;
}

export interface ContentOperations {
	readBytes(file: FileRef, options: ByteReadOptions, context: FsOperationContext): Promise<FsResult<ByteContent>>;
	readText(file: FileRef, options: TextReadOptions, context: FsOperationContext): Promise<FsResult<TextContent>>;
	scanLines(file: FileRef, options: TextReadOptions, context: FsOperationContext): Promise<FsResult<LineScan>>;
}
