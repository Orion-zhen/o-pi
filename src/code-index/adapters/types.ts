import type ParserModule from "tree-sitter";

import type { SupportedCodeLanguage } from "../types.js";

export type TreeSitterLanguage = ParserModule.Language;
export type SyntaxNode = ParserModule.SyntaxNode;

/** 描述 grammar package 的 CommonJS 导出位置；省略 exportName 表示使用整个模块导出。 */
export interface GrammarSpec {
	readonly packageName: string;
	readonly exportName?: string;
}

export interface RawUnit {
	readonly kind: string;
	readonly name?: string;
	readonly qualifiedName?: string;
	readonly startChar: number;
	readonly endChar: number;
}

export interface RawImport {
	readonly specifier: string;
	readonly startChar: number;
	readonly endChar: number;
}

/** 阶段 1 使用的 adapter 元数据；不会在导入时加载 grammar。 */
export interface LanguageAdapterMetadata {
	readonly language: SupportedCodeLanguage;
	readonly extensions: readonly string[];
	readonly grammar: GrammarSpec;
}

/** 完整语言 adapter 的公共契约；import 与 symbol 均从同一 AST 提取。 */
export interface LanguageAdapter extends LanguageAdapterMetadata {
	extractUnits(root: SyntaxNode): RawUnit[];
	extractImports(root: SyntaxNode): RawImport[];
}
