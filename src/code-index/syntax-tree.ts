import { loadTreeSitterRuntime } from "./tree-sitter-loader.js";
import type { CodeLanguage } from "./types.js";
import type { SyntaxNode } from "./adapters/types.js";

/**
 * 创建无状态 Parser、设置对应 grammar 并解析一个文档。
 * 返回的 tree 可能包含 Tree-sitter error 节点；调用方按领域策略决定是否接受它。
 */
export function parseSyntaxTree(language: CodeLanguage, text: string): SyntaxNode | undefined {
	try {
		const runtime = loadTreeSitterRuntime(language);
		if (runtime === undefined) return undefined;
		const parser = new runtime.Parser();
		parser.setLanguage(runtime.language);
		return parser.parse(text).rootNode;
	} catch {
		return undefined;
	}
}
