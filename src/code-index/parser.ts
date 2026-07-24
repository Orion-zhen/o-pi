import type { RawImport, RawUnit } from "./adapters/types.js";
import { indexRawImports } from "./adapters/shared.js";
import { createFileIdentity, createSymbolId } from "./identity.js";
import { getLanguageAdapter, languageFromPath } from "./language-registry.js";
import { parseDocument } from "./syntax-tree.js";
import { SourceIndex } from "./types.js";
import type { AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit, LineIndex, ParsedDocument, ParsedFileIndex, SourceRange } from "./types.js";

export { languageFromPath } from "./language-registry.js";
export { parseDocument, sourceRangeForNode } from "./syntax-tree.js";
export type { AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit, IndexedImport, LineIndex, ParsedDocument, ParsedFileIndex, SourceRange } from "./types.js";
export { SourceIndex } from "./types.js";

const IDENTIFIER = /[A-Za-z_$][\w$]*|[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_-]+|\d+/g;

/** 解析单个文件的代码单元；不支持或解析失败时返回空索引，由 grep 层退化为文本片段。 */
export function parseCodeUnits(filePath: string, text: string): ParsedFileIndex {
	return analyzeCodeFile(filePath, text).index;
}

/** Repo Map 使用的详细结果；保留 parser 失败状态与文件级 import 事实。 */
export function analyzeCodeFile(filePath: string, text: string): AnalyzedFileIndex {
	const language = languageFromPath(filePath);
	const document = parseDocument(language, text);
	const analyzed = analyzeDocument(filePath, document);
	return document === undefined ? analyzed : { ...analyzed, document };
}

/** 在已解析的 ParsedDocument 上建立 code index；文档只在本次调用链中存活。 */
export function analyzeDocument(filePath: string, document: ParsedDocument | undefined): AnalyzedFileIndex {
	const file = createFileIdentity(filePath);
	const language = document?.language ?? languageFromPath(filePath);
	const adapter = getLanguageAdapter(language);
	if (adapter === undefined) return emptyAnalyzedFile(file, language, "unsupported");
	if (document === undefined) return emptyAnalyzedFile(file, language, "error");

	const { sourceIndex, text, root } = document;
	let units: IndexedCodeUnit[];
	let rawImports: RawImport[];
	try {
		units = adapter.extractUnits(root).map((unit) => buildIndexedUnit(file, language, text, sourceIndex, unit));
		rawImports = adapter.extractImports(root);
	} catch {
		return emptyAnalyzedFile(file, language, "error");
	}
	return {
		index: {
			...file,
			language,
			units,
			symbols: units.flatMap((unit) => [unit.name, unit.qualifiedName].filter((value): value is string => value !== undefined)),
		},
		status: "parsed",
		imports: indexRawImports(sourceIndex, rawImports),
	};
}

/** 对不适合语法解析的大文件保留完整文本召回，但不进入 Tree-sitter。 */
export function analyzeTextFile(filePath: string): AnalyzedFileIndex {
	const file = createFileIdentity(filePath);
	return {
		index: { ...file, language: languageFromPath(filePath), units: [], symbols: [] },
		status: "unsupported",
		imports: [],
	};
}

export function tokenizeText(value: string): Map<string, number> {
	const result = new Map<string, number>();
	for (const raw of splitTokens(value)) {
		const token = raw.toLocaleLowerCase();
		if (token.length === 0) continue;
		result.set(token, (result.get(token) ?? 0) + 1);
	}
	return result;
}

export function splitTokens(value: string): string[] {
	const tokens: string[] = [];
	for (const match of value.matchAll(IDENTIFIER)) {
		const raw = match[0] ?? "";
		tokens.push(raw);
		// lower-case identifiers and numbers cannot gain another token from
		// camel/snake/kebab splitting; avoid three regex passes for the common case.
		if (!/^[a-z0-9]+$/u.test(raw)) tokens.push(...splitIdentifier(raw));
	}
	return Array.from(new Set(tokens.filter((token) => token.length > 0)));
}

/** Count normalized query tokens present in text without materializing its complete token map. */
export function countTextTokenMatches(value: string, queryTokens: readonly string[]): number {
	if (queryTokens.length === 0) return 0;
	const expected = new Set(queryTokens);
	const matched = new Set<string>();
	for (const match of value.matchAll(IDENTIFIER)) {
		const raw = match[0] ?? "";
		const normalized = raw.toLocaleLowerCase();
		if (expected.has(normalized)) matched.add(normalized);
		if (!/^[a-z0-9]+$/u.test(raw)) {
			for (const part of splitIdentifier(raw)) {
				const normalizedPart = part.toLocaleLowerCase();
				if (expected.has(normalizedPart)) matched.add(normalizedPart);
			}
		}
		if (matched.size === expected.size) break;
	}
	let count = 0;
	for (const token of queryTokens) if (matched.has(token)) count += 1;
	return count;
}

export function lineForByte(text: string, byteOffset: number): number {
	return buildLineIndex(text).lineForByte(byteOffset);
}

export function byteRangeForLines(text: string, startLine: number, endLine: number): SourceRange {
	return byteRangeForLinesWithIndex(buildLineIndex(text), startLine, endLine);
}

export function byteRangeForLinesWithIndex(index: LineIndex, startLine: number, endLine: number): SourceRange {
	const startByte = index.lineStarts[Math.max(0, startLine - 1)] ?? 0;
	const endByte = index.lineStarts[endLine] ?? index.byteLength;
	return { startLine, endLine, startByte, endByte };
}

/** 按 byte 截取 grep 展示文本；code unit 热路径使用 ParsedDocument 的 char slice。 */
export function extractByteRange(text: string, startByte: number, endByte: number): string {
	return Buffer.from(text, "utf8").subarray(startByte, endByte).toString("utf8").replace(/\s+$/u, "");
}

function emptyAnalyzedFile(file: { id: string; path: string }, language: CodeLanguage, status: AnalyzedFileIndex["status"]): AnalyzedFileIndex {
	return {
		index: { ...file, language, units: [], symbols: [] },
		status,
		imports: [],
	};
}

function buildIndexedUnit(file: { id: string; path: string }, language: CodeLanguage, text: string, sourceIndex: SourceIndex, unit: RawUnit): IndexedCodeUnit {
	const range = sourceIndex.range(unit.startChar, unit.endChar);
	const { startByte, endByte } = range;
	const content = text.slice(unit.startChar, unit.endChar).replace(/\s+$/u, "");
	const signature = firstNonEmptyLine(content);
	const nameText = [file.path, unit.name, unit.qualifiedName, signature, content].join("\n");
	const tokens = tokenizeText(nameText);
	const references = Array.from(new Set(splitTokens(content))).filter((token) => !/^\d+$/u.test(token));
	const calls = Array.from(content.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/gu), (match) => match[1] ?? "").filter(Boolean);
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
		...(signature !== undefined ? { signature } : {}),
		exported: unit.exported,
		startLine: range.startLine,
		endLine: range.endLine,
		startByte,
		endByte,
		tokens,
		definitions: unit.name === undefined ? [] : [unit.name],
		references,
		calls,
	};
}

function firstNonEmptyLine(text: string): string | undefined {
	return text.split(/\n/u).find((line) => line.trim().length > 0)?.trim();
}

export function buildLineIndex(text: string): SourceIndex {
	return new SourceIndex(text);
}

function splitIdentifier(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.split(/[^A-Za-z0-9]+/u)
		.filter(Boolean);
}
