export type SupportedCodeLanguage = "javascript" | "jsx" | "typescript" | "tsx" | "python" | "go" | "rust";
export type CodeLanguage = SupportedCodeLanguage | "text";

export interface LineIndex {
	readonly lineStarts: number[];
	readonly lineStartChars: number[];
	readonly byteLength: number;
}

/** 行范围为 1-based inclusive，字节范围为 UTF-8 [startByte, endByte)。 */
export interface SourceRange {
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
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
