import type { TreeSitterLanguage } from "../syntax-tree/grammars.js";

export type CodeLanguage = TreeSitterLanguage | "text";
type ImportKind = "relative" | "external";

/** 行范围为 1-based inclusive，字节范围为 UTF-8 [startByte, endByte)。 */
export interface SourceRange {
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
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
	/** 需要结构归属的 UTF-8 半开正文范围，空数组表示 related 全局分析。 */
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

interface CodeAnalysisPreparationInput {
	readonly paths: readonly string[];
	readonly signal?: AbortSignal;
}

/** 只返回完整事务，不可用、能力不足或任一阶段失败时返回 undefined。 */
export interface CodeAnalysis {
	readonly mode: "symbol";
	/** 必须与请求 targets 完全一致，files 可以只是其中实际产生 symbol 结果的子集。 */
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
	kind: string;
	name: string;
	qualifiedName?: string;
	signature?: string;
	/** UTF-8 半开边界，用于判断事实命中是否已由 signature 展示。 */
	declarationEndByte?: number;
	authority: CodeAuthority;
	exported: boolean;
	definitions: string[];
	references: string[];
	calls: string[];
}

/** 依赖推断只需要静态模块名及其路径语义，不保存导入位置。 */
export interface ModuleImport {
	specifier: string;
	importKind?: ImportKind;
}

export interface AnalyzedFileIndex {
	path: string;
	language: CodeLanguage;
	status: "parsed" | "unsupported" | "error";
	units: IndexedCodeUnit[];
	imports: ModuleImport[];
}
