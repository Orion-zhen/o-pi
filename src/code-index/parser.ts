import type { LanguageAdapter, RawImport, RawUnit } from "./adapters/types.js";
import { extractUnitRelations, indexRawImports } from "./adapters/shared.js";
import { createFileIdentity, createSymbolId } from "./identity.js";
import { getLanguageAdapter, languageFromPath, loadLanguageAdapter } from "./language-registry.js";
import {
	CodeAnalysisTimeoutError,
	isCodeAnalysisControlError,
	parseDocumentForAdapter,
	parseDocumentResult,
	type ParseDocumentResult,
} from "./syntax-tree.js";
import { SourceIndex } from "./types.js";
import type { AnalysisControl, AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit, ParsedDocument, ParsedFileIndex } from "./types.js";

export { languageFromPath } from "./language-registry.js";
export { parseDocument, parseDocumentForAdapter, parseDocumentResult, sourceRangeForNode } from "./syntax-tree.js";
export type { AnalyzedFileIndex, CodeAuthority, CodeLanguage, ImportKind, IndexedCodeUnit, IndexedImport, LineIndex, ParseFailure, ParsedDocument, ParsedFileIndex, SourceRange } from "./types.js";
export type { ParseDocumentResult } from "./syntax-tree.js";
export { SourceIndex } from "./types.js";

const IDENTIFIER = /[A-Za-z_$][\w$]*|[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_-]+|\d+/g;
const DECLARATION_CODE_POINT_LIMIT = 240;
const EMPTY_TEXT_TOKENS: readonly string[] = [];

export interface AnalyzeCodeFileOptions {
	/** Keep the parsed document for immediate additional extraction. The caller must dispose it. */
	retainDocument?: boolean;
	timeoutMicros?: number;
	signal?: AbortSignal;
}

/** 解析单个文件的代码单元；不支持或解析失败时返回空索引，由 grep 层退化为文本片段。 */
export async function parseCodeUnits(filePath: string, text: string): Promise<ParsedFileIndex> {
	return (await analyzeCodeFile(filePath, text)).index;
}

/** 代码索引使用的详细结果；保留 parser 失败状态与文件级 import 事实。 */
export async function analyzeCodeFile(
	filePath: string,
	text: string,
	options: AnalyzeCodeFileOptions = {},
): Promise<AnalyzedFileIndex> {
	const language = languageFromPath(filePath);
	const adapter = language === "bash" ? await loadLanguageAdapter(language) : getLanguageAdapter(language);
	const parsed: ParseDocumentResult = adapter === undefined
		? await parseDocumentResult(language, text, {
				...(options.timeoutMicros !== undefined ? { timeoutMicros: options.timeoutMicros } : {}),
				...(options.signal !== undefined ? { signal: options.signal } : {}),
			})
		: await parseDocumentForAdapter(adapter, text, options.timeoutMicros, options.signal);
	const document = parsed.document;
	let retained = false;
	try {
		let analyzed: AnalyzedFileIndex;
		try {
			analyzed = analyzeDocumentWithAdapter(filePath, document, adapter);
		} catch (error) {
			if (!(error instanceof CodeAnalysisTimeoutError)) throw error;
			analyzed = {
				...emptyAnalyzedFile(createFileIdentity(filePath), language, "error"),
				failure: { code: "PARSER_TIMEOUT", message: error.message },
			};
		}
		const result = parsed.failure !== undefined && analyzed.status === "error"
			? { ...analyzed, failure: parsed.failure }
			: analyzed;
		if (document === undefined || options.retainDocument !== true || result.status !== "parsed") return result;
		retained = true;
		return { ...result, document };
	} finally {
		if (document !== undefined && !retained) document.dispose();
	}
}

/** 在已解析的 ParsedDocument 上建立 code index；文档只在本次调用链中存活。 */
export function analyzeDocument(filePath: string, document: ParsedDocument | undefined): AnalyzedFileIndex {
	const language = document?.language ?? languageFromPath(filePath);
	const adapter = getLanguageAdapter(language);
	return analyzeDocumentWithAdapter(filePath, document, adapter);
}

function analyzeDocumentWithAdapter(
	filePath: string,
	document: ParsedDocument | undefined,
	adapter: LanguageAdapter | undefined,
): AnalyzedFileIndex {
	const file = createFileIdentity(filePath);
	const language = document?.language ?? languageFromPath(filePath);
	if (adapter === undefined) return emptyAnalyzedFile(file, language, "unsupported");
	if (document === undefined) return emptyAnalyzedFile(file, language, "error");

	const { sourceIndex, text, root } = document;
	let units: IndexedCodeUnit[];
	let rawImports: RawImport[];
	try {
		const rawUnits = adapter.extractUnits(root, document.control);
		const unitNodeIds = new Set(rawUnits.map((unit) => unit.sourceNode.id));
		units = rawUnits.map((unit) => buildIndexedUnit(file, language, text, sourceIndex, unit, unitNodeIds, document.control));
		rawImports = adapter.extractImports(root, document.control);
	} catch (error) {
		if (isCodeAnalysisControlError(error)) throw error;
		return emptyAnalyzedFile(file, language, "error");
	}
	return {
		index: {
			...file,
			language,
			units,
		},
		status: "parsed",
		imports: indexRawImports(sourceIndex, rawImports),
	};
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

/** 保留标准归一化和标识符拆分后的词项顺序。 */
export function tokenizeTextSequence(value: string): string[] {
	const result: string[] = [];
	visitTokenOccurrences(value, (raw) => {
		result.push(raw.toLocaleLowerCase());
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

/** Count normalized query tokens present in text without materializing its complete token map. */
export function countTextTokenMatches(value: string, queryTokens: readonly string[]): number {
	if (queryTokens.length === 0) return 0;
	const expected = new Set(queryTokens);
	const matched = matchingTextTokens(value, expected);
	if (matched === undefined) return 0;
	let count = 0;
	for (const token of queryTokens) if (matched.has(token)) count += 1;
	return count;
}

export function lineForByte(text: string, byteOffset: number): number {
	return buildLineIndex(text).lineForByte(byteOffset);
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
			...(unit.name !== undefined ? { name: unit.name } : {}),
			...(unit.qualifiedName !== undefined ? { qualifiedName: unit.qualifiedName } : {}),
			startByte,
		}),
		path: file.path,
		language,
		kind: unit.kind,
		...(unit.name !== undefined ? { name: unit.name } : {}),
		...(unit.qualifiedName !== undefined ? { qualifiedName: unit.qualifiedName } : {}),
		...(declaration === undefined ? {} : { signature: declaration.text, declarationEndByte: declaration.endByte }),
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
): { readonly text: string; readonly endByte: number } | undefined {
	if (unit.declarationEndChar === null) return undefined;
	const end = unit.declarationEndChar ?? unit.endChar;
	if (end <= unit.startChar || end > unit.endChar) return undefined;
	const compact = text.slice(unit.startChar, end).replace(/\s+/gu, " ").trim();
	if (compact.length === 0) return undefined;
	const points = [...compact];
	const declaration = points.length <= DECLARATION_CODE_POINT_LIMIT
		? compact
		: `${points.slice(0, DECLARATION_CODE_POINT_LIMIT - 3).join("")}...`;
	return { text: declaration, endByte: sourceIndex.byteForChar(end) };
}

export function buildLineIndex(text: string): SourceIndex {
	return new SourceIndex(text);
}

function visitTokenOccurrences(value: string, visit: (token: string) => boolean | void): void {
	for (const match of value.matchAll(IDENTIFIER)) {
		const raw = match[0] ?? "";
		if (raw.length === 0) continue;
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
