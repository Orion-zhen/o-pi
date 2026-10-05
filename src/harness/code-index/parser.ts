import { parseSyntaxTree, SyntaxAnalysisTimeoutError } from "../syntax-tree/parser.ts";
import { TREE_SITTER_LANGUAGES, languageFromPath } from "../syntax-tree/grammars.ts";
import type { AnalysisControl, SyntaxNode, SyntaxTreeDocument } from "../syntax-tree/types.ts";
import { createFileIdentity, createSymbolId } from "./identity.ts";
import { LANGUAGE_EXTRACTORS } from "./language-registry.ts";
import { extractCallSites } from "./relations.ts";
import { SourceIndex } from "./source-index.ts";
import { compactDeclaration } from "./text.ts";
import { linkCodeUnits } from "./structure.ts";
import type { AnalyzedFileIndex, IndexedCodeUnit, SourceRange } from "./types.ts";

/** 解析结果保留错误区域。取消直接传播，调用方不把恢复节点当作可靠边界。 */
export async function analyzeCodeFile(filePath: string, text: string, signal?: AbortSignal): Promise<AnalyzedFileIndex> {
	const file = createFileIdentity(filePath);
	const language = languageFromPath(filePath);
	const empty: AnalyzedFileIndex = { path: file.path, language, status: "unsupported", units: [] };
	if (language === "text") return empty;
	const extractor = LANGUAGE_EXTRACTORS[language];
	let document: SyntaxTreeDocument | undefined;
	try {
		document = await parseSyntaxTree(TREE_SITTER_LANGUAGES[language].grammar, text, signal);
		if (document === undefined) return { ...empty, status: "error" };
		const { root, control } = document;
		const sourceIndex = new SourceIndex(text, control);
		const parseErrors = syntaxErrors(root, sourceIndex, control);
		const rawUnits = extractor.extractUnits(root, text, control);
		const owners = new Map<number, string>();
		const units: IndexedCodeUnit[] = rawUnits.map((unit) => {
			const range = sourceIndex.range(unit.startChar, unit.endChar);
			const declarationEnd = unit.declarationEndChar ?? unit.endChar;
			const id = createSymbolId({ fileId: file.id, kind: unit.kind, symbolName: unit.qualifiedName ?? "", startByte: range.startByte });
			if (unit.callableNode !== undefined) owners.set(unit.callableNode.id, id);
			return {
				id, path: file.path, kind: unit.kind,
				...(unit.name === undefined ? {} : { name: unit.name }),
				...(unit.qualifiedName === undefined ? {} : { qualifiedName: unit.qualifiedName }),
				signature: compactDeclaration(text.slice(unit.startChar, declarationEnd)),
				declarationEndByte: sourceIndex.byteForChar(declarationEnd),
				authority: "defined",
				...range,
				syntax: {
					...(unit.context === undefined ? {} : { context: unit.context }),
					...(unit.callableNode === undefined ? {} : { callable: true as const }),
					range,
					...(unit.nameNode === undefined ? {} : { nameRange: sourceIndex.range(unit.nameNode.startIndex, unit.nameNode.endIndex) }),
					...(unit.bodyNode === undefined ? {} : { body: sourceIndex.range(unit.bodyNode.startIndex, unit.bodyNode.endIndex) }),
					errors: parseErrors.filter((error) => error.startByte <= range.endByte && range.startByte <= error.endByte),
				},
			};
		});
		return {
			path: file.path, language, status: "parsed", units: linkCodeUnits(units),
			parseErrors,
			callSites: extractCallSites(root, owners, sourceIndex, extractor.call, control),
		};
	} catch (error) {
		if (error instanceof SyntaxAnalysisTimeoutError) return { ...empty, status: "error" };
		throw error;
	} finally {
		document?.dispose();
	}
}

function syntaxErrors(root: SyntaxNode, source: SourceIndex, control: AnalysisControl): SourceRange[] {
	const errors: SourceRange[] = [];
	const stack = [root];
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		control.check();
		if (node.isError || node.isMissing) errors.push(source.range(node.startIndex, node.endIndex));
		else if (node.hasError) for (const child of [...node.children].reverse()) stack.push(child);
	}
	return errors;
}
