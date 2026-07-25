import type { Tree } from "web-tree-sitter";

import { getLanguageAdapter } from "./language-registry.js";
import { DEFAULT_PARSE_TIMEOUT_MICROS, invalidateTreeSitterParser, loadTreeSitterParser } from "./tree-sitter-loader.js";
import type { LanguageAdapter, SyntaxNode } from "./adapters/types.js";
import type { AnalysisControl, CodeLanguage, ParseFailure, ParsedDocument, SourceIndex, SourceRange } from "./types.js";
import { SourceIndex as SourceIndexClass } from "./types.js";

export interface ParseDocumentResult {
	document?: ParsedDocument;
	failure?: ParseFailure;
}

export interface ParseDocumentOptions {
	timeoutMicros?: number;
	signal?: AbortSignal;
}

export class CodeAnalysisAbortedError extends Error {
	constructor() {
		super("Tree-sitter analysis was aborted.");
		this.name = "CodeAnalysisAbortedError";
	}
}

export class CodeAnalysisTimeoutError extends Error {
	constructor() {
		super("Tree-sitter parsing exceeded the configured timeout.");
		this.name = "CodeAnalysisTimeoutError";
	}
}

/** Parse through the built-in registry; grammar loading remains lazy per language. */
export async function parseDocumentResult(
	language: CodeLanguage,
	text: string,
	options: ParseDocumentOptions = {},
): Promise<ParseDocumentResult> {
	const adapter = getLanguageAdapter(language);
	return adapter === undefined
		? { failure: { code: "RUNTIME_UNAVAILABLE", message: "No Tree-sitter adapter is registered for this language." } }
		: await parseDocumentForAdapter(adapter, text, options.timeoutMicros, options.signal);
}

/** Direct registry path for isolated adapters; does not perform plugin discovery. */
export async function parseDocumentForAdapter(
	adapter: LanguageAdapter,
	text: string,
	timeoutMicros = DEFAULT_PARSE_TIMEOUT_MICROS,
	signal?: AbortSignal,
): Promise<ParseDocumentResult> {
	if (isAborted(signal)) throw new CodeAnalysisAbortedError();
	const parserResult = await loadTreeSitterParser(adapter);
	if ("failure" in parserResult) return parserResult;
	const parser = parserResult.parser;
	let tree: Tree | null = null;
	try {
		parser.reset();
		const deadline = performance.now() + normalizeTimeoutMicros(timeoutMicros) / 1_000;
		const control = createAnalysisControl(deadline, signal);
		tree = parser.parse(text, null, {
			progressCallback: () => isAborted(signal) || performance.now() >= deadline,
		});
		if (tree === null) {
			safeReset(parser);
			if (isAborted(signal)) throw new CodeAnalysisAbortedError();
			return parserTimeout();
		}
		const sourceIndex = new SourceIndexClass(text, control);
		const root = tree.rootNode;
		let disposed = false;
		return {
			document: {
				language: adapter.language,
				text,
				root,
				sourceIndex,
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
		if (error instanceof CodeAnalysisAbortedError) {
			safeReset(parser);
			throw error;
		}
		if (error instanceof CodeAnalysisTimeoutError) {
			safeReset(parser);
			return parserTimeout();
		}
		invalidateTreeSitterParser(adapter, parser);
		return { failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter raised an exception while parsing the file." } };
	}
}

/** Parse one document. The caller must dispose a returned document. */
export async function parseDocument(
	language: CodeLanguage,
	text: string,
	options: ParseDocumentOptions = {},
): Promise<ParsedDocument | undefined> {
	return (await parseDocumentResult(language, text, options)).document;
}

/** 将 Tree-sitter 的 UTF-16 字符范围转换为统一的 SourceRange。 */
export function sourceRangeForNode(index: SourceIndex, node: SyntaxNode): SourceRange {
	return index.range(node.startIndex, node.endIndex);
}

export function isCodeAnalysisControlError(error: unknown): error is CodeAnalysisAbortedError | CodeAnalysisTimeoutError {
	return error instanceof CodeAnalysisAbortedError || error instanceof CodeAnalysisTimeoutError;
}

function createAnalysisControl(deadline: number, signal: AbortSignal | undefined): AnalysisControl {
	return {
		check() {
			if (isAborted(signal)) throw new CodeAnalysisAbortedError();
			if (performance.now() >= deadline) throw new CodeAnalysisTimeoutError();
		},
	};
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function normalizeTimeoutMicros(timeoutMicros: number): number {
	return Number.isFinite(timeoutMicros) ? Math.max(0, timeoutMicros) : DEFAULT_PARSE_TIMEOUT_MICROS;
}

function parserTimeout(): ParseDocumentResult {
	return { failure: { code: "PARSER_TIMEOUT", message: "Tree-sitter parsing exceeded the configured timeout." } };
}

function safeDeleteTree(tree: Tree | null): void {
	try {
		tree?.delete();
	} catch {
		// The document no longer exposes the failed tree after this boundary.
	}
}

function safeReset(parser: { reset(): void }): void {
	try {
		parser.reset();
	} catch {
		// The next parse will return a structured failure if the parser is unusable.
	}
}
