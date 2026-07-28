import type { Language, Node } from "web-tree-sitter";

import type { AnalysisControl, ImportKind, SupportedCodeLanguage } from "../types.js";

export type TreeSitterLanguage = Language;
export type SyntaxNode = Node;

/** 描述 grammar package 中的 WebAssembly 语言文件。 */
export interface GrammarSpec {
	readonly packageName: string;
	readonly wasmFile: string;
}

export interface RawUnit {
	readonly kind: string;
	readonly name?: string;
	readonly qualifiedName?: string;
	readonly exported: boolean;
	readonly startChar: number;
	readonly endChar: number;
	/** Body/implementation 开始处；缺失时整个 sourceNode 都是声明，null 表示无法安全生成。 */
	readonly declarationEndChar?: number | null;
	/** Transient declaration node used to derive lexical facts in the same parse. */
	readonly sourceNode: SyntaxNode;
}

export interface RawImport {
	readonly specifier: string;
	readonly startChar: number;
	readonly endChar: number;
	readonly importKind?: ImportKind;
}

/** 阶段 1 使用的 adapter 元数据；不会在导入时加载 grammar。 */
export interface LanguageAdapterMetadata {
	readonly language: SupportedCodeLanguage;
	readonly extensions: readonly string[];
	readonly grammar: GrammarSpec;
}

/** 完整语言 adapter 的公共契约；import 与 symbol 均从同一 AST 提取。 */
export interface LanguageAdapter extends LanguageAdapterMetadata {
	extractUnits(root: SyntaxNode, control: AnalysisControl): RawUnit[];
	extractImports(root: SyntaxNode, control: AnalysisControl): RawImport[];
}
