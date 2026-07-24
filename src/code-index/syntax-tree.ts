import { getLanguageAdapter } from "./language-registry.js";
import * as treeSitterLoader from "./tree-sitter-loader.js";
import type { LanguageAdapter, SyntaxNode } from "./adapters/types.js";
import type { CodeLanguage, ParseFailure, ParsedDocument, SourceIndex, SourceRange } from "./types.js";
import { SourceIndex as SourceIndexClass } from "./types.js";

export interface ParseDocumentResult {
	document?: ParsedDocument;
	failure?: ParseFailure;
}

/** Parse through the built-in registry; grammar loading remains lazy per language. */
export function parseSyntaxTree(language: CodeLanguage, text: string): SyntaxNode | undefined {
	return parseDocumentResult(language, text).document?.root;
}

/** Parse through the built-in registry and retain a serializable failure when native parsing cannot start. */
export function parseDocumentResult(language: CodeLanguage, text: string): ParseDocumentResult {
	const adapter = getLanguageAdapter(language);
	return adapter === undefined
		? { failure: { code: "RUNTIME_UNAVAILABLE", message: "No Tree-sitter adapter is registered for this language." } }
		: parseDocumentForAdapter(adapter, text);
}

/** Direct registry path for isolated adapters; does not perform plugin discovery. */
export function parseSyntaxTreeForAdapter(adapter: LanguageAdapter, text: string, timeoutMicros?: number): SyntaxNode | undefined {
	return parseDocumentForAdapter(adapter, text, timeoutMicros).document?.root;
}

export function parseDocumentForAdapter(adapter: LanguageAdapter, text: string, timeoutMicros?: number): ParseDocumentResult {
	const parserLoader = "loadTreeSitterParser" in treeSitterLoader ? treeSitterLoader.loadTreeSitterParser : undefined;
	if (typeof parserLoader !== "function") {
		try {
			treeSitterLoader.loadTreeSitterRuntime(adapter.grammar);
		} catch {
			return { failure: { code: "RUNTIME_UNAVAILABLE", message: "Tree-sitter parser loader is unavailable." } };
		}
		return { failure: { code: "RUNTIME_UNAVAILABLE", message: "Tree-sitter parser loader is unavailable." } };
	}
	const parserResult = parserLoader(adapter, timeoutMicros);
	if ("failure" in parserResult) return parserResult;
	try {
		parserResult.parser.reset();
		const tree = parserResult.parser.parse(text);
		if (tree === null || tree === undefined) {
			safeReset(parserResult.parser);
			return { failure: { code: "PARSER_TIMEOUT", message: "Tree-sitter parsing exceeded the configured timeout." } };
		}
		return {
			document: {
				language: adapter.language,
				text,
				root: tree.rootNode,
				sourceIndex: new SourceIndexClass(text),
			},
		};
	} catch {
		safeReset(parserResult.parser);
		return { failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter raised an exception while parsing the file." } };
	}
}

/** Compatibility wrapper returning only the document. */
export function parseDocument(language: CodeLanguage, text: string): ParsedDocument | undefined {
	return parseDocumentResult(language, text).document;
}

/** 将 Tree-sitter 的 UTF-16 字符范围转换为统一的 SourceRange。 */
export function sourceRangeForNode(index: SourceIndex, node: SyntaxNode): SourceRange {
	return index.range(node.startIndex, node.endIndex);
}

function safeReset(parser: { reset(): void }): void {
	try {
		parser.reset();
	} catch {
		// The next parse will create a fresh failure if the native parser is unusable.
	}
}
