import type { Node } from "web-tree-sitter";

export type SyntaxNode = Node;

/** 可由 Node 解析的 grammar WASM 包子路径。 */
export type GrammarSpec = string;

export interface AnalysisControl {
	/** 解析或 AST 分析应停止时抛出异常。 */
	check(): void;
}

export interface SyntaxTreeDocument {
	readonly root: SyntaxNode;
	readonly control: AnalysisControl;
	/** 释放底层 WebAssembly 语法树，可重复调用。 */
	dispose(): void;
}
