import type { SyntaxNode } from "./adapters/types.js";

export type SupportedCodeLanguage = "javascript" | "jsx" | "typescript" | "tsx" | "python" | "go" | "rust" | "c" | "cpp";
export type CodeLanguage = SupportedCodeLanguage | "text";

/** 行范围为 1-based inclusive，字节范围为 UTF-8 [startByte, endByte)。 */
export interface SourceRange {
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
}

export interface LineIndex {
	readonly lineStarts: number[];
	readonly lineStartChars: number[];
	readonly byteLength: number;
	byteForChar(charOffset: number): number;
	lineForByte(byteOffset: number): number;
}

/**
 * 文本的共享坐标索引。
 *
 * Tree-sitter 的 JS binding 使用 UTF-16 字符偏移，而公开的 SourceRange 使用
 * UTF-8 byte 偏移。ASCII 文件直接使用字符偏移；其他文件只为整个文档建立一
 * 次 UTF-16 -> UTF-8 映射。
 */
export class SourceIndex implements LineIndex {
	readonly lineStarts: number[];
	readonly lineStartChars: number[];
	readonly byteLength: number;
	readonly #charLength: number;
	readonly #charToByte: Uint32Array | undefined;

	constructor(text: string) {
		const lineStarts = [0];
		const lineStartChars = [0];
		let bytes = 0;
		let ascii = true;

		for (let index = 0; index < text.length; index += 1) {
			const code = text.charCodeAt(index);
			if (code < 0x80) {
				bytes += 1;
			} else {
				ascii = false;
				if (code < 0x800) {
					bytes += 2;
				} else if (isSurrogatePair(text, index)) {
					bytes += 4;
					index += 1;
				} else {
					bytes += 3;
				}
			}
			if (code === 0x0a) {
				lineStarts.push(bytes);
				lineStartChars.push(index + 1);
			}
		}

		this.lineStarts = lineStarts;
		this.lineStartChars = lineStartChars;
		this.byteLength = bytes;
		this.#charLength = text.length;
		this.#charToByte = ascii ? undefined : buildCharToByte(text);
	}

	get charLength(): number {
		return this.#charLength;
	}

	get isAscii(): boolean {
		return this.#charToByte === undefined;
	}

	byteForChar(charOffset: number): number {
		const offset = clampOffset(charOffset, this.#charLength);
		return this.#charToByte?.[offset] ?? offset;
	}

	lineForByte(byteOffset: number): number {
		let low = 0;
		let high = this.lineStarts.length - 1;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const start = this.lineStarts[middle] ?? 0;
			if (start <= byteOffset) low = middle + 1;
			else high = middle - 1;
		}
		return Math.max(1, high + 1);
	}

	range(startChar: number, endChar: number): SourceRange {
		const startByte = this.byteForChar(startChar);
		const endByte = this.byteForChar(endChar);
		return {
			startLine: this.lineForByte(startByte),
			endLine: this.lineForByte(Math.max(startByte, endByte - 1)),
			startByte,
			endByte,
		};
	}
}

export interface ParsedDocument {
	readonly language: CodeLanguage;
	readonly text: string;
	readonly root: SyntaxNode;
	readonly sourceIndex: SourceIndex;
}

export interface FileIdentity {
	id: string;
	path: string;
}

export interface SymbolIdentityInput {
	fileId: string;
	kind: string;
	name?: string;
	qualifiedName?: string;
	startByte: number;
}

export interface IndexedCodeUnit extends SourceRange {
	id: string;
	path: string;
	language: CodeLanguage;
	kind: string;
	name?: string;
	qualifiedName?: string;
	signature?: string;
	tokens: Map<string, number>;
	definitions: string[];
	references: string[];
	calls: string[];
	imports: string[];
}

export interface ParsedFileIndex extends FileIdentity {
	language: CodeLanguage;
	units: IndexedCodeUnit[];
	symbols: string[];
}

export interface IndexedImport extends SourceRange {
	specifier: string;
}

export interface AnalyzedFileIndex {
	index: ParsedFileIndex;
	status: "parsed" | "unsupported" | "error";
	imports: IndexedImport[];
}

function buildCharToByte(text: string): Uint32Array {
	const offsets = new Uint32Array(text.length + 1);
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
			offsets[index + 1] = bytes;
			continue;
		}
		if (code < 0x800) {
			bytes += 2;
			offsets[index + 1] = bytes;
			continue;
		}
		if (isSurrogatePair(text, index)) {
			bytes += 4;
			offsets[index + 1] = bytes;
			index += 1;
			offsets[index + 1] = bytes;
			continue;
		}
		bytes += 3;
		offsets[index + 1] = bytes;
	}
	return offsets;
}

function isSurrogatePair(text: string, index: number): boolean {
	const high = text.charCodeAt(index);
	const low = text.charCodeAt(index + 1);
	return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function clampOffset(value: number, length: number): number {
	return Math.min(length, Math.max(0, Math.trunc(value)));
}
