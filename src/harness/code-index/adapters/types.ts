import type { AnalysisControl, SyntaxNode } from "../../syntax-tree/types.ts";

export interface RawUnit {
	readonly kind: string;
	readonly name?: string;
	readonly qualifiedName?: string;
	readonly nameNode?: SyntaxNode;
	readonly bodyNode?: SyntaxNode;
	readonly callableNode?: SyntaxNode;
	/** 外部声明已拥有的匿名函数，不重复提取。 */
	readonly ownedCallable?: number;
	readonly context?: string;
	readonly startChar: number;
	readonly endChar: number;
	/** 实现开始处，缺失时整个单元都是声明。 */
	readonly declarationEndChar?: number;
}

export interface RawCall {
	readonly callee: SyntaxNode;
	readonly lookup?: SyntaxNode;
}

export interface LanguageExtractor {
	extractUnits(root: SyntaxNode, text: string, control: AnalysisControl): RawUnit[];
	call(node: SyntaxNode): RawCall | undefined;
}
