import type { AnalysisControl, SyntaxNode } from "../../syntax-tree/types.js";
import type { ModuleImport } from "../types.js";

export interface RawUnit {
	readonly kind: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly exported: boolean;
	readonly startChar: number;
	readonly endChar: number;
	/** 实现开始处，缺失时整个 sourceNode 都是声明。 */
	readonly declarationEndChar?: number;
	/** 仅在本次解析中用于提取词法关系，不进入结果或缓存。 */
	readonly sourceNode: SyntaxNode;
}

export interface LanguageExtractor {
	extractUnits(root: SyntaxNode, control: AnalysisControl): RawUnit[];
	extractImports(root: SyntaxNode, control: AnalysisControl): ModuleImport[];
}
