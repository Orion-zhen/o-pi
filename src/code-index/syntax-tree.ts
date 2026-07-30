import type { LanguageAdapter, SyntaxNode } from "./adapters/types.js";
import { getLanguageAdapter, loadLanguageAdapter } from "./language-registry.js";
import {
	isSyntaxAnalysisControlError,
	parseSyntaxTree,
	SyntaxAnalysisAbortedError,
	SyntaxAnalysisTimeoutError,
} from "../syntax-tree/parser.js";
import type { CodeLanguage, ParseFailure, ParsedDocument, SourceIndex, SourceRange } from "./types.js";
import { SourceIndex as SourceIndexClass } from "./types.js";

export interface ParseDocumentResult {
	document?: ParsedDocument;
	failure?: ParseFailure;
}

export interface ParseDocumentOptions {
	timeoutMicros?: number;
	signal?: AbortSignal;
}

export {
	SyntaxAnalysisAbortedError as CodeAnalysisAbortedError,
	SyntaxAnalysisTimeoutError as CodeAnalysisTimeoutError,
};

/** 通过代码语言 registry 解析；runtime、grammar 和 parser 由共享语法层统一缓存。 */
export async function parseDocumentResult(
	language: CodeLanguage,
	text: string,
	options: ParseDocumentOptions = {},
): Promise<ParseDocumentResult> {
	const adapter = language === "bash" ? await loadLanguageAdapter(language) : getLanguageAdapter(language);
	return adapter === undefined
		? { failure: { code: "RUNTIME_UNAVAILABLE", message: "No Tree-sitter adapter is registered for this language." } }
		: await parseDocumentForAdapter(adapter, text, options.timeoutMicros, options.signal);
}

/** 直接解析一个代码 adapter，不执行插件发现。 */
export async function parseDocumentForAdapter(
	adapter: LanguageAdapter,
	text: string,
	timeoutMicros?: number,
	signal?: AbortSignal,
): Promise<ParseDocumentResult> {
	const parsed = await parseSyntaxTree(adapter.grammar, text, {
		...(timeoutMicros === undefined ? {} : { timeoutMicros }),
		...(signal === undefined ? {} : { signal }),
	});
	const syntaxDocument = parsed.document;
	if (syntaxDocument === undefined) {
		return parsed.failure === undefined
			? { failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter returned no document or failure." } }
			: { failure: parsed.failure };
	}

	try {
		const sourceIndex = new SourceIndexClass(text, syntaxDocument.control);
		return {
			document: {
				language: adapter.language,
				text,
				root: syntaxDocument.root,
				sourceIndex,
				control: syntaxDocument.control,
				dispose: syntaxDocument.dispose,
			},
		};
	} catch (error) {
		syntaxDocument.dispose();
		if (error instanceof SyntaxAnalysisAbortedError) throw error;
		if (error instanceof SyntaxAnalysisTimeoutError) {
			return { failure: { code: "PARSER_TIMEOUT", message: error.message } };
		}
		return { failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter raised an exception while preparing the parsed source." } };
	}
}

/** 解析一份代码文档；调用方必须释放返回值。 */
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

export const isCodeAnalysisControlError = isSyntaxAnalysisControlError;
