import type { Tree } from "web-tree-sitter";
import { loadGrammar } from "./loader.js";
import type { GrammarSpec, SyntaxTreeDocument } from "./types.js";

const PARSE_DEADLINE_MS = 250;

export class SyntaxAnalysisAbortedError extends Error {
	constructor() {
		super("Tree-sitter analysis was aborted.");
		this.name = "SyntaxAnalysisAbortedError";
	}
}

export class SyntaxAnalysisTimeoutError extends Error {
	constructor() {
		super("Tree-sitter parsing exceeded its deadline.");
		this.name = "SyntaxAnalysisTimeoutError";
	}
}

/** 加载和解析失败返回 undefined，取消向上传播。文档拥有独立于解析器的语法树。 */
export async function parseSyntaxTree(grammar: GrammarSpec, text: string, signal?: AbortSignal): Promise<SyntaxTreeDocument | undefined> {
	if (signal?.aborted === true) throw new SyntaxAnalysisAbortedError();
	let tree: Tree | null = null;
	try {
		const parse = await loadGrammar(grammar);
		if (isAborted()) throw new SyntaxAnalysisAbortedError();
		const deadline = performance.now() + PARSE_DEADLINE_MS;
		tree = parse(text, { progressCallback: () => isAborted() || performance.now() >= deadline });
		if (isAborted()) throw new SyntaxAnalysisAbortedError();
		if (tree === null) return undefined;
		return {
			root: tree.rootNode,
			control: {
				check() {
					if (isAborted()) throw new SyntaxAnalysisAbortedError();
					if (performance.now() >= deadline) throw new SyntaxAnalysisTimeoutError();
				},
			},
			dispose,
		};
	} catch (error) {
		dispose();
		if (error instanceof SyntaxAnalysisAbortedError) throw error;
		if (isAborted()) throw new SyntaxAnalysisAbortedError();
		return undefined;
	}

	function isAborted(): boolean {
		return signal?.aborted === true;
	}

	function dispose(): void {
		const owned = tree;
		tree = null;
		owned?.delete();
	}
}
