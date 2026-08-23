import type { RawUnit } from "./adapters/types.js";
import { extractUnitRelations, indexRawImports } from "./adapters/shared.js";
import { createFileIdentity, createSymbolId } from "./identity.js";
import { getLanguageAdapter, languageFromPath } from "./language-registry.js";
import { parseSyntaxTree, SyntaxAnalysisAbortedError } from "../syntax-tree/parser.js";
import type { SyntaxTreeDocument } from "../syntax-tree/types.js";
import { SourceIndex } from "./types.js";
import type { AnalysisControl, AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit } from "./types.js";

export { languageFromPath } from "./language-registry.js";
export type { AnalyzedFileIndex, CodeAuthority, CodeLanguage, ImportKind, IndexedCodeUnit, IndexedImport, LineIndex, ParsedFileIndex, SourceRange } from "./types.js";
export { SourceIndex } from "./types.js";

const IDENTIFIER = /[A-Za-z_$][\w$]*|[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_-]+|\d+/g;
const DECLARATION_CODE_POINT_LIMIT = 240;
const EMPTY_TEXT_TOKENS: readonly string[] = [];

/** 解析单个文件的代码单元；不支持或解析失败时返回空索引，由 grep 层退化为文本片段。 */
export async function analyzeCodeFile(
	filePath: string,
	text: string,
	signal?: AbortSignal,
): Promise<AnalyzedFileIndex> {
	const file = createFileIdentity(filePath);
	const language = languageFromPath(filePath);
	const adapter = getLanguageAdapter(language);
	if (adapter === undefined) return emptyAnalyzedFile(file, language, "unsupported");

	let document: SyntaxTreeDocument | undefined;
	try {
		document = await parseSyntaxTree(adapter.grammar, text, signal === undefined ? {} : { signal });
		if (document === undefined) return emptyAnalyzedFile(file, language, "error");
		const tree = document;

		const sourceIndex = new SourceIndex(text, tree.control);
		const rawUnits = adapter.extractUnits(tree.root, tree.control);
		const unitNodeIds = new Set(rawUnits.map((unit) => unit.sourceNode.id));
		const units = rawUnits.map((unit) => buildIndexedUnit(file, language, text, sourceIndex, unit, unitNodeIds, tree.control));
		const rawImports = adapter.extractImports(tree.root, tree.control);
		return {
			index: {
				...file,
				language,
				units,
			},
			status: "parsed",
			imports: indexRawImports(sourceIndex, rawImports),
		};
	} catch (error) {
		if (error instanceof SyntaxAnalysisAbortedError) throw error;
		return emptyAnalyzedFile(file, language, "error");
	} finally {
		document?.dispose();
	}
}

/** 对不适合语法解析的大文件保留完整文本召回，但不进入 Tree-sitter。 */
export function analyzeTextFile(filePath: string): AnalyzedFileIndex {
	const file = createFileIdentity(filePath);
	return {
		index: { ...file, language: languageFromPath(filePath), units: [] },
		status: "unsupported",
		imports: [],
	};
}

export function tokenizeText(value: string): Map<string, number> {
	const result = new Map<string, number>();
	visitTokenOccurrences(value, (raw) => {
		const token = raw.toLocaleLowerCase();
		result.set(token, (result.get(token) ?? 0) + 1);
	});
	return result;
}

export function splitTokens(value: string): string[] {
	const tokens = new Set<string>();
	visitTokenOccurrences(value, (token) => {
		tokens.add(token);
	});
	return [...tokens];
}

/** 为已归一化查询词项建立轻量匹配器，不为正文中的无关词项分配计数 Map。 */
export function createTextTokenMatcher(queryTokens: readonly string[]): (value: string) => readonly string[] {
	const ordered = [...new Set(queryTokens)];
	const expected = new Set(ordered);
	return (value) => {
		if (expected.size === 0) return EMPTY_TEXT_TOKENS;
		const matched = matchingTextTokens(value, expected);
		if (matched === undefined) return EMPTY_TEXT_TOKENS;
		return ordered.filter((token) => matched.has(token));
	};
}

/** 最小代码单元优先；相同范围使用稳定坐标与 identity 破平。 */
export function compareCodeUnitNesting(left: IndexedCodeUnit, right: IndexedCodeUnit): number {
	return (left.endByte - left.startByte) - (right.endByte - right.startByte)
		|| left.startByte - right.startByte
		|| (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function emptyAnalyzedFile(file: { id: string; path: string }, language: CodeLanguage, status: AnalyzedFileIndex["status"]): AnalyzedFileIndex {
	return {
		index: { ...file, language, units: [] },
		status,
		imports: [],
	};
}

function buildIndexedUnit(
	file: { id: string; path: string },
	language: CodeLanguage,
	text: string,
	sourceIndex: SourceIndex,
	unit: RawUnit,
	unitNodeIds: ReadonlySet<number>,
	control: AnalysisControl,
): IndexedCodeUnit {
	const range = sourceIndex.range(unit.startChar, unit.endChar);
	const { startByte, endByte } = range;
	const declaration = compactDeclaration(text, sourceIndex, unit);
	const { definitions, references, calls } = extractUnitRelations(unit, unitNodeIds, control);
	return {
		id: createSymbolId({
			fileId: file.id,
			kind: unit.kind,
			name: unit.name,
			qualifiedName: unit.qualifiedName,
			startByte,
		}),
		path: file.path,
		language,
		kind: unit.kind,
		name: unit.name,
		qualifiedName: unit.qualifiedName,
		signature: declaration.text,
		declarationEndByte: declaration.endByte,
		authority: "defined",
		exported: unit.exported,
		startLine: range.startLine,
		endLine: range.endLine,
		startByte,
		endByte,
		definitions,
		references,
		calls,
	};
}

function compactDeclaration(
	text: string,
	sourceIndex: SourceIndex,
	unit: RawUnit,
): { readonly text: string; readonly endByte: number } {
	const end = unit.declarationEndChar ?? unit.endChar;
	const compact = text.slice(unit.startChar, end).replace(/\s+/gu, " ").trim();
	const points = [...compact];
	const declaration = points.length <= DECLARATION_CODE_POINT_LIMIT
		? compact
		: `${points.slice(0, DECLARATION_CODE_POINT_LIMIT - 3).join("")}...`;
	return { text: declaration, endByte: sourceIndex.byteForChar(end) };
}

function visitTokenOccurrences(value: string, visit: (token: string) => boolean | void): void {
	for (const match of value.matchAll(IDENTIFIER)) {
		const raw = match[0];
		if (visit(raw) === false) return;
		// lower-case identifiers and numbers cannot gain another token from
		// camel/snake/kebab splitting; avoid three regex passes for the common case.
		if (/^[a-z0-9]+$/u.test(raw)) continue;
		for (const part of splitIdentifier(raw)) if (visit(part) === false) return;
	}
}

function matchingTextTokens(value: string, expected: ReadonlySet<string>): ReadonlySet<string> | undefined {
	let matched: Set<string> | undefined;
	visitTokenOccurrences(value, (raw) => {
		const normalized = raw.toLocaleLowerCase();
		if (expected.has(normalized)) (matched ??= new Set()).add(normalized);
		return (matched?.size ?? 0) < expected.size;
	});
	return matched;
}

function splitIdentifier(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.split(/[^A-Za-z0-9]+/u)
		.filter(Boolean);
}
