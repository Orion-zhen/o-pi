import { byteForCharWithIndex, lineForByteWithIndex } from "./adapters/shared.js";
import type { RawUnit } from "./adapters/types.js";
import { createFileIdentity, createSymbolId } from "./identity.js";
import { getLanguageAdapter, languageFromPath } from "./language-registry.js";
import { loadTreeSitterRuntime } from "./tree-sitter-loader.js";
import type { AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit, LineIndex, ParsedFileIndex, SourceRange } from "./types.js";

export { languageFromPath } from "./language-registry.js";
export type { AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit, IndexedImport, LineIndex, ParsedFileIndex, SourceRange } from "./types.js";

const IDENTIFIER = /[A-Za-z_$][\w$]*|[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_-]+|\d+/g;

/** 解析单个文件的代码单元；不支持或解析失败时返回空索引，由 grep 层退化为文本片段。 */
export function parseCodeUnits(filePath: string, text: string): ParsedFileIndex {
	return analyzeCodeFile(filePath, text).index;
}

/** Repo Map 使用的详细结果；保留 parser 失败状态与文件级 import 事实。 */
export function analyzeCodeFile(filePath: string, text: string): AnalyzedFileIndex {
	const file = createFileIdentity(filePath);
	const language = languageFromPath(filePath);
	const lineIndex = buildLineIndex(text);
	const parsed = parseByLanguage(language, text);
	const units = parsed.units.map((unit) => buildIndexedUnit(file, language, text, lineIndex, unit));
	return {
		index: {
			...file,
			language,
			units,
			symbols: units.flatMap((unit) => [unit.name, unit.qualifiedName].filter((value): value is string => value !== undefined)),
		},
		status: parsed.status,
		imports: parsed.status === "parsed" ? collectFileImports(language, text, lineIndex) : [],
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
	return lineForByteWithIndex(buildLineIndex(text), byteOffset);
}

export function byteRangeForLines(text: string, startLine: number, endLine: number): SourceRange {
	return byteRangeForLinesWithIndex(buildLineIndex(text), startLine, endLine);
}

export function byteRangeForLinesWithIndex(index: LineIndex, startLine: number, endLine: number): SourceRange {
	const startByte = index.lineStarts[Math.max(0, startLine - 1)] ?? 0;
	const endByte = index.lineStarts[endLine] ?? index.byteLength;
	return { startLine, endLine, startByte, endByte };
}

export function extractByteRange(text: string, startByte: number, endByte: number): string {
	return Buffer.from(text, "utf8").subarray(startByte, endByte).toString("utf8").replace(/\s+$/u, "");
}

function parseByLanguage(language: CodeLanguage, text: string): { status: AnalyzedFileIndex["status"]; units: RawUnit[] } {
	const adapter = getLanguageAdapter(language);
	if (adapter === undefined) return { status: "unsupported", units: [] };
	try {
		const runtime = loadTreeSitterRuntime(language);
		if (runtime === undefined) return { status: "error", units: [] };
		const parser = new runtime.Parser();
		parser.setLanguage(runtime.language);
		return { status: "parsed", units: adapter.extractUnits(parser.parse(text).rootNode) };
	} catch {
		return { status: "error", units: [] };
	}
}

function collectFileImports(language: CodeLanguage, text: string, lineIndex: LineIndex) {
	return getLanguageAdapter(language)?.collectImports(text, lineIndex) ?? [];
}

function buildIndexedUnit(file: { id: string; path: string }, language: CodeLanguage, text: string, lineIndex: LineIndex, unit: RawUnit): IndexedCodeUnit {
	const startByte = byteForCharWithIndex(text, lineIndex, unit.startChar);
	const endByte = byteForCharWithIndex(text, lineIndex, unit.endChar);
	const content = extractByteRange(text, startByte, endByte);
	const signature = firstNonEmptyLine(content);
	const nameText = [file.path, unit.name, unit.qualifiedName, signature, content].join("\n");
	const tokens = tokenizeText(nameText);
	const references = Array.from(new Set(splitTokens(content))).filter((token) => !/^\d+$/u.test(token));
	const calls = Array.from(content.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/gu), (match) => match[1] ?? "").filter(Boolean);
	const imports = Array.from(content.matchAll(/\b(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/gu), (match) => match[1] ?? "").filter(Boolean);
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
		startLine: lineForByteWithIndex(lineIndex, startByte),
		endLine: lineForByteWithIndex(lineIndex, Math.max(startByte, endByte - 1)),
		startByte,
		endByte,
		tokens,
		definitions: unit.name === undefined ? [] : [unit.name],
		references,
		calls,
		imports,
	};
}

function firstNonEmptyLine(text: string): string | undefined {
	return text.split(/\n/u).find((line) => line.trim().length > 0)?.trim();
}

export function buildLineIndex(text: string): LineIndex {
	const lineStarts = [0];
	const lineStartChars = [0];
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
		if (code === 0x0a) {
			lineStarts.push(bytes);
			lineStartChars.push(index + 1);
		}
	}
	return { lineStarts, lineStartChars, byteLength: bytes };
}

function splitIdentifier(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.split(/[^A-Za-z0-9]+/u)
		.filter(Boolean);
}
