import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { throwIfAborted } from "./errors.js";
import type { RepoMapEvidence, RepoMapFileRecord, RepoMapSymbolNode } from "./types.js";

export interface RepoMapSourceFile {
	file: RepoMapFileRecord;
	text: string;
}

export type RepoMapReadText = (absolutePath: string, signal?: AbortSignal) => Promise<string>;

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function readTextNoFollow(absolutePath: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return await handle.readFile({ encoding: "utf8", ...(signal !== undefined ? { signal } : {}) });
	} finally {
		await handle.close();
	}
}

export function fileEvidence(file: RepoMapFileRecord): RepoMapEvidence {
	return {
		path: file.path,
		...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}),
		startLine: 1,
		endLine: 1,
		startByte: 0,
		endByte: 0,
	};
}

export function symbolEvidence(file: RepoMapFileRecord, symbol: RepoMapSymbolNode): RepoMapEvidence {
	return {
		path: file.path,
		...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}),
		startLine: symbol.startLine,
		endLine: symbol.endLine,
		startByte: symbol.startByte,
		endByte: symbol.endByte,
	};
}

/** Convert UTF-16 string offsets to the UTF-8 byte ranges used by Repo Map. */
export function sourceEvidence(source: RepoMapSourceFile, start: number, end: number): RepoMapEvidence {
	const safeStart = Math.max(0, Math.min(start, source.text.length));
	const safeEnd = Math.max(safeStart, Math.min(end, source.text.length));
	const startByte = Buffer.byteLength(source.text.slice(0, safeStart));
	return {
		path: source.file.path,
		...(source.file.contentHash !== undefined ? { textHash: source.file.contentHash } : {}),
		startLine: lineAt(source.text, safeStart),
		endLine: lineAt(source.text, Math.max(safeStart, safeEnd - 1)),
		startByte,
		endByte: startByte + Buffer.byteLength(source.text.slice(safeStart, safeEnd)),
	};
}

export function rangeEvidence(source: RepoMapSourceFile, range: { startLine: number; endLine: number; startByte: number; endByte: number }): RepoMapEvidence {
	return {
		path: source.file.path,
		...(source.file.contentHash !== undefined ? { textHash: source.file.contentHash } : {}),
		startLine: range.startLine,
		endLine: range.endLine,
		startByte: range.startByte,
		endByte: range.endByte,
	};
}

export function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < Math.min(offset, text.length); index += 1) {
		if (text.charCodeAt(index) === 10) line += 1;
	}
	return line;
}
