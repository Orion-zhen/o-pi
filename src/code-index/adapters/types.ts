import type { AnalysisControl, ImportKind, SupportedCodeLanguage } from "../types.js";
import type { GrammarSpec, SyntaxNode } from "../../syntax-tree/types.js";

export type { GrammarSpec, SyntaxNode };

export interface RawUnit {
	readonly kind: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly exported: boolean;
	readonly startChar: number;
	readonly endChar: number;
	/** Body/implementation 开始处；缺失时整个 sourceNode 都是声明。 */
	readonly declarationEndChar?: number;
	/** Transient declaration node used to derive lexical facts in the same parse. */
	readonly sourceNode: SyntaxNode;
}

export interface RawImport {
	readonly specifier: string;
	readonly startChar: number;
	readonly endChar: number;
	readonly importKind?: ImportKind;
}

/** 完整语言 adapter 的公共契约；import 与 symbol 均从同一 AST 提取。 */
export interface LanguageAdapter {
	readonly language: SupportedCodeLanguage;
	readonly extensions: readonly string[];
	readonly grammar: GrammarSpec;
	extractUnits(root: SyntaxNode, control: AnalysisControl): RawUnit[];
	extractImports(root: SyntaxNode, control: AnalysisControl): RawImport[];
}
