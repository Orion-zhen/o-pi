import type { SyntaxNode } from "./adapters/types.js";
import type { AnalysisControl, ParseFailure, ParseFailureCode } from "../syntax-tree/types.js";
import type { TreeSitterLanguage } from "../syntax-tree/grammars.js";

export type { AnalysisControl, ParseFailure, ParseFailureCode };

export type SupportedCodeLanguage = TreeSitterLanguage;
export type CodeLanguage = SupportedCodeLanguage | "text";
export type ImportKind = "relative" | "external";

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

	constructor(text: string, control?: AnalysisControl) {
		const lineStarts = [0];
		const lineStartChars = [0];
		let bytes = 0;
		let ascii = true;

		for (let index = 0; index < text.length; index += 1) {
			if ((index & 0xfff) === 0) control?.check();
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
		this.#charToByte = ascii ? undefined : buildCharToByte(text, control);
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
	readonly control: AnalysisControl;
	/** Release the underlying WebAssembly syntax tree. Idempotent. */
	dispose(): void;
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

/** 定义作为依赖目标的最强语义证据。 */
export type CodeAuthority = "called" | "referenced" | "defined";

export interface CodeDocument {
	/** 当前工具 scope 内的规范相对路径。 */
	readonly path: string;
	readonly text: string;
	readonly hash: string;
}

export interface CodeAnalysisTarget {
	/** 本次 analyzer 必须原子覆盖的规范相对路径。 */
	readonly path: string;
	/** 需要结构归属的 UTF-8 半开正文范围；空数组表示 related 全局分析。 */
	readonly ranges: readonly {
		readonly startByte: number;
		readonly endByte: number;
	}[];
}

export interface CodeAnalysisInput {
	readonly query: string;
	readonly targets: readonly CodeAnalysisTarget[];
	readonly allowRelated: boolean;
	readonly limit: number;
	readonly signal?: AbortSignal;
	load(path: string): Promise<CodeDocument | undefined>;
}

export interface CodeAnalysisPreparationInput {
	readonly paths: readonly string[];
	readonly signal?: AbortSignal;
}

/** 只返回完整事务；不可用、能力不足或任一阶段失败时返回 undefined。 */
export interface CodeAnalysis {
	readonly mode: "symbol";
	/** 必须与请求 targets 完全一致；files 可以只是其中实际产生 symbol 结果的子集。 */
	readonly coveredPaths: readonly string[];
	readonly files: readonly {
		readonly document: CodeDocument;
		readonly analysis: AnalyzedFileIndex;
	}[];
}

export type AnalyzeCode = (input: CodeAnalysisInput) => Promise<CodeAnalysis | undefined>;
export type PrepareCodeAnalysis = (input: CodeAnalysisPreparationInput) => Promise<void>;

export interface IndexedCodeUnit extends SourceRange {
	id: string;
	path: string;
	language: CodeLanguage;
	kind: string;
	name?: string;
	qualifiedName?: string;
	signature?: string;
	/** UTF-8 半开边界；用于判断事实命中是否已由 signature 展示。 */
	declarationEndByte?: number;
	authority: CodeAuthority;
	exported: boolean;
	definitions: string[];
	references: string[];
	calls: string[];
}

export interface ParsedFileIndex extends FileIdentity {
	language: CodeLanguage;
	units: IndexedCodeUnit[];
}

export interface IndexedImport extends SourceRange {
	specifier: string;
	importKind?: ImportKind;
}

export interface AnalyzedFileIndex {
	index: ParsedFileIndex;
	status: "parsed" | "unsupported" | "error";
	imports: IndexedImport[];
	failure?: ParseFailure;
	/** Transient AST ownership for consumers that extract additional facts in one parse. */
	document?: ParsedDocument;
}

function buildCharToByte(text: string, control?: AnalysisControl): Uint32Array {
	const offsets = new Uint32Array(text.length + 1);
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		if ((index & 0xfff) === 0) control?.check();
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
