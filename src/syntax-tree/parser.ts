import type { Tree } from "web-tree-sitter";

import {
	DEFAULT_PARSE_TIMEOUT_MICROS,
	invalidateTreeSitterParser,
	loadTreeSitterParser,
} from "./loader.js";
import type { AnalysisControl, GrammarSpec, ParseFailure, SyntaxTreeDocument } from "./types.js";

export interface ParseSyntaxTreeResult {
	document?: SyntaxTreeDocument;
	failure?: ParseFailure;
}

export interface ParseSyntaxTreeOptions {
	timeoutMicros?: number;
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
		super("Tree-sitter parsing exceeded the configured timeout.");
		this.name = "SyntaxAnalysisTimeoutError";
	}
}

/** 使用共享 runtime 和 grammar cache 解析任意已注册语法。 */
export async function parseSyntaxTree(
	grammar: GrammarSpec,
	text: string,
	options: ParseSyntaxTreeOptions = {},
): Promise<ParseSyntaxTreeResult> {
	if (isAborted(options.signal)) throw new SyntaxAnalysisAbortedError();
	const parserResult = await loadTreeSitterParser(grammar);
	if ("failure" in parserResult) return parserResult;
	const parser = parserResult.parser;
	let tree: Tree | null = null;
	try {
		parser.reset();
		const deadline = performance.now() + normalizeTimeoutMicros(options.timeoutMicros) / 1_000;
		const control = createAnalysisControl(deadline, options.signal);
		tree = parser.parse(text, null, {
			progressCallback: () => isAborted(options.signal) || performance.now() >= deadline,
		});
		if (tree === null) {
			safeReset(parser);
			if (isAborted(options.signal)) throw new SyntaxAnalysisAbortedError();
			return parserTimeout();
		}
		const root = tree.rootNode;
		let disposed = false;
		return {
			document: {
				text,
				root,
				control,
				dispose() {
					if (disposed) return;
					disposed = true;
					safeDeleteTree(tree);
					tree = null;
				},
			},
		};
	} catch (error) {
		safeDeleteTree(tree);
		tree = null;
		if (error instanceof SyntaxAnalysisAbortedError) {
			safeReset(parser);
			throw error;
		}
		if (error instanceof SyntaxAnalysisTimeoutError) {
			safeReset(parser);
			return parserTimeout();
		}
		invalidateTreeSitterParser(grammar, parser);
		return { failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter raised an exception while parsing the source." } };
	}
}

export function isSyntaxAnalysisControlError(error: unknown): error is SyntaxAnalysisAbortedError | SyntaxAnalysisTimeoutError {
	return error instanceof SyntaxAnalysisAbortedError || error instanceof SyntaxAnalysisTimeoutError;
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

function normalizeTimeoutMicros(timeoutMicros: number | undefined): number {
	return timeoutMicros === undefined || !Number.isFinite(timeoutMicros)
		? DEFAULT_PARSE_TIMEOUT_MICROS
		: Math.max(0, timeoutMicros);
}

function parserTimeout(): ParseSyntaxTreeResult {
	return { failure: { code: "PARSER_TIMEOUT", message: "Tree-sitter parsing exceeded the configured timeout." } };
}

function safeDeleteTree(tree: Tree | null): void {
	try {
		tree?.delete();
	} catch {
		// 文档边界之外不再暴露失败 tree。
	}
}

function safeReset(parser: { reset(): void }): void {
	try {
		parser.reset();
	} catch {
		// 下一次解析会把不可复用 parser 转成结构化失败。
	}
}
