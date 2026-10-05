import type { CodeRelation } from "./relation-types.ts";
import type { TreeSitterLanguage } from "../syntax-tree/grammars.ts";

export type CodeLanguage = TreeSitterLanguage | "text";

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
	/** 本次分析的规范相对路径。 */
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
	/** 复用调用方的有界语法缓存，不触发额外文件读取。 */
	syntax(document: CodeDocument, signal?: AbortSignal): Promise<AnalyzedFileIndex>;
}

interface CodeAnalysisPreparationInput {
	readonly paths: readonly string[];
	readonly signal?: AbortSignal;
}

export type CodeAnalysisStatus = "ok" | "unsupported" | "unavailable" | "timeout" | "skipped";

export type CodeFeatureResult<T> =
	| { readonly status: "ok"; readonly value: T }
	| { readonly status: Exclude<CodeAnalysisStatus, "ok"> };

export interface CodeAnalysisCoverage {
	readonly path: string;
	/** 本次符号选择的状态。成功的空集合仍为 ok，部分或全部候选受预算限制时为 skipped。 */
	readonly symbols: CodeAnalysisStatus;
	readonly workspaceSymbols?: CodeAnalysisStatus;
}

export interface CodeRelationStatus {
	readonly incomingCalls: CodeAnalysisStatus;
	readonly outgoingCalls: CodeAnalysisStatus;
	readonly references: CodeAnalysisStatus;
	readonly definitions: CodeAnalysisStatus;
	readonly validation: CodeAnalysisStatus;
}

export interface AnalyzedCodeFile {
	readonly document: CodeDocument;
	readonly analysis: AnalyzedFileIndex;
	/** 本次查询选择的增强单元，不进入语法缓存。 */
	readonly selectedIds: readonly string[];
}

export interface CodeFileAnalysis {
	readonly coverage: CodeAnalysisCoverage;
	readonly file?: AnalyzedCodeFile;
}

/** 按目标保留结果，关系在整次查询内归一化。用户取消时返回 undefined。 */
export interface CodeAnalysis {
	readonly results: readonly CodeFileAnalysis[];
	readonly relations: readonly CodeRelation[];
}

export type AnalyzeCode = (input: CodeAnalysisInput) => Promise<CodeAnalysis | undefined>;
export type PrepareCodeAnalysis = (input: CodeAnalysisPreparationInput) => Promise<void>;

/** 已通过本次搜索快照校验的关系位置，不代表正文命中。 */
export interface CodeNavigation {
	readonly kind: "caller" | "callee" | "reference";
	readonly source: "hierarchy" | "definition" | "references";
	readonly ambiguous?: true;
	readonly path: string;
	readonly line: number;
	readonly column: number;
}

export interface CodeCallSite extends SourceRange {
	readonly callee: SourceRange;
	readonly lookupByte?: number;
	readonly ownerId?: string;
}

export interface CodeStructureIssue {
	readonly path: string;
	readonly kind: "parse" | "range" | "ambiguous";
	readonly range: SourceRange;
}

export interface CodeSyntaxStructure {
	/** 匿名函数的有界源码上下文，包含直接调用表达式的前缀。 */
	readonly context?: string;
	readonly callable?: true;
	readonly range: SourceRange;
	readonly nameRange?: SourceRange;
	readonly body?: SourceRange;
	readonly errors: readonly SourceRange[];
}

export type CodeSymbolStructure = {
	readonly range: SourceRange;
	readonly parentId?: string;
} & (
	| { readonly type: "document"; readonly selection: SourceRange }
	| { readonly type: "location" }
);

interface CodeUnitBase extends SourceRange {
	id: string;
	path: string;
	kind: string;
	name?: string;
	qualifiedName?: string;
	parentId?: string;
	structureConflict?: "range" | "ambiguous";
	signature?: string;
	/** UTF-8 半开边界，用于判断事实命中是否已由 signature 展示。 */
	declarationEndByte?: number;
	authority: CodeAuthority;
	navigation?: readonly CodeNavigation[];
	relationStatus?: CodeRelationStatus;
}

/** 源码区域与语义符号分开保存。组合后顶层范围仍优先采用有效的 LSP 符号范围。 */
export type IndexedCodeUnit = CodeUnitBase & (
	| { syntax: CodeSyntaxStructure; symbol?: CodeSymbolStructure }
	| { symbol: CodeSymbolStructure; syntax?: CodeSyntaxStructure }
);

export interface AnalyzedFileIndex {
	path: string;
	language: CodeLanguage;
	status: "parsed" | "unsupported" | "error";
	units: IndexedCodeUnit[];
	/** 仅语法分析提供，缺失不代表语法无错。 */
	parseErrors?: readonly SourceRange[];
	callSites?: readonly CodeCallSite[];
}
