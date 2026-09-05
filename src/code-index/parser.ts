import { parseSyntaxTree, SyntaxAnalysisAbortedError } from "../syntax-tree/parser.js";
import { TREE_SITTER_LANGUAGES, languageFromPath } from "../syntax-tree/grammars.js";
import type { SyntaxTreeDocument } from "../syntax-tree/types.js";
import { createFileIdentity, createSymbolId } from "./identity.js";
import { LANGUAGE_EXTRACTORS } from "./language-registry.js";
import { extractUnitRelations } from "./relations.js";
import { SourceIndex } from "./source-index.js";
import { compactDeclaration } from "./text.js";
import type { AnalyzedFileIndex } from "./types.js";

/** 不支持或解析失败时返回空单元，由 grep 层回退到文本片段。取消直接向上传播。 */
export async function analyzeCodeFile(filePath: string, text: string, signal?: AbortSignal): Promise<AnalyzedFileIndex> {
	const file = createFileIdentity(filePath);
	const language = languageFromPath(filePath);
	const empty: AnalyzedFileIndex = { path: file.path, language, status: "unsupported", units: [], imports: [] };
	if (language === "text") return empty;
	const extractor = LANGUAGE_EXTRACTORS[language];
	let document: SyntaxTreeDocument | undefined;
	try {
		document = await parseSyntaxTree(TREE_SITTER_LANGUAGES[language].grammar, text, signal);
		if (document === undefined) return { ...empty, status: "error" };
		const { root, control } = document;
		const sourceIndex = new SourceIndex(text, control);
		const rawUnits = extractor.extractUnits(root, control);
		const unitNodeIds = new Set(rawUnits.map((unit) => unit.sourceNode.id));
		const units = rawUnits.map((unit) => {
			const range = sourceIndex.range(unit.startChar, unit.endChar);
			const declarationEnd = unit.declarationEndChar ?? unit.endChar;
			return {
				id: createSymbolId({ fileId: file.id, kind: unit.kind, symbolName: unit.qualifiedName, startByte: range.startByte }),
				path: file.path,
				kind: unit.kind,
				name: unit.name,
				qualifiedName: unit.qualifiedName,
				signature: compactDeclaration(text.slice(unit.startChar, declarationEnd)),
				declarationEndByte: sourceIndex.byteForChar(declarationEnd),
				authority: "defined" as const,
				exported: unit.exported,
				...range,
				...extractUnitRelations(unit, unitNodeIds, control),
			};
		});
		return { path: file.path, language, status: "parsed", units, imports: extractor.extractImports(root, control) };
	} catch (error) {
		if (error instanceof SyntaxAnalysisAbortedError) throw error;
		return { ...empty, status: "error" };
	} finally {
		document?.dispose();
	}
}
