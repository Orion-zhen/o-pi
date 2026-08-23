import type { Tree } from "web-tree-sitter";

import { invalidateTreeSitterParser, loadTreeSitterParser } from "./loader.js";
import type { AnalysisControl, GrammarSpec, SyntaxTreeDocument } from "./types.js";

const PARSE_DEADLINE_MS = 250;

export interface ParseSyntaxTreeOptions {
	signal?: AbortSignal;
}

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

/** 使用共享 runtime、language 和 parser cache 解析任意已注册语法。 */
export async function parseSyntaxTree(
	grammar: GrammarSpec,
	text: string,
	options: ParseSyntaxTreeOptions = {},
): Promise<SyntaxTreeDocument | undefined> {
	if (isAborted(options.signal)) throw new SyntaxAnalysisAbortedError();
	const parser = await loadTreeSitterParser(grammar);
	if (isAborted(options.signal)) throw new SyntaxAnalysisAbortedError();
	if (parser === undefined) return undefined;

	let tree: Tree | null = null;
	try {
		parser.reset();
		const deadline = performance.now() + PARSE_DEADLINE_MS;
		const control = createAnalysisControl(deadline, options.signal);
		tree = parser.parse(text, null, {
			progressCallback: () => isAborted(options.signal) || performance.now() >= deadline,
		});
		if (tree === null) {
			safeReset(parser);
			if (isAborted(options.signal)) throw new SyntaxAnalysisAbortedError();
			return undefined;
		}
		const root = tree.rootNode;
		let disposed = false;
		return {
			text,
			root,
			control,
			dispose() {
				if (disposed) return;
				disposed = true;
				safeDeleteTree(tree);
				tree = null;
			},
		};
	} catch (error) {
		safeDeleteTree(tree);
		tree = null;
		if (error instanceof SyntaxAnalysisAbortedError) {
			safeReset(parser);
			throw error;
		}
		invalidateTreeSitterParser(grammar, parser);
		return undefined;
	}
}

function createAnalysisControl(deadline: number, signal: AbortSignal | undefined): AnalysisControl {
	return {
		check() {
			if (isAborted(signal)) throw new SyntaxAnalysisAbortedError();
			if (performance.now() >= deadline) throw new SyntaxAnalysisTimeoutError();
		},
	};
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function safeDeleteTree(tree: Tree | null): void {
	try {
		tree?.delete();
	} catch {
		// Tree 已离开文档所有权边界。
	}
}

function safeReset(parser: { reset(): void }): void {
	try {
		parser.reset();
	} catch {
		// 无法确认 parser 可复用时，交由后续解析处理。
	}
}
