import type { Node } from "web-tree-sitter";

export type SyntaxNode = Node;

/** 描述 grammar package 中的 WebAssembly 语言文件。 */
export interface GrammarSpec {
	readonly packageName: string;
	readonly wasmFile: string;
}

export type ParseFailureCode =
	| "RUNTIME_UNAVAILABLE"
	| "GRAMMAR_UNAVAILABLE"
	| "GRAMMAR_INCOMPATIBLE"
	| "PARSER_INITIALIZATION_FAILED"
	| "PARSER_EXCEPTION"
	| "PARSER_TIMEOUT";

export interface ParseFailure {
	readonly code: ParseFailureCode;
	readonly message: string;
}

export interface AnalysisControl {
	/** 解析或 AST 分析应停止时抛出异常。 */
	check(): void;
}

export interface SyntaxTreeDocument {
	readonly text: string;
	readonly root: SyntaxNode;
	readonly control: AnalysisControl;
	/** 释放底层 WebAssembly syntax tree；可重复调用。 */
	dispose(): void;
}
