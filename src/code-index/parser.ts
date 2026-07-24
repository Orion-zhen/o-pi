import type ParserModule from "tree-sitter";

import type { RawUnit } from "./adapters/types.js";
import { createFileIdentity, createSymbolId } from "./identity.js";
import { languageFromPath } from "./language-registry.js";
import { loadTreeSitterRuntime } from "./tree-sitter-loader.js";
import type { AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit, IndexedImport, LineIndex, ParsedFileIndex, SourceRange } from "./types.js";

export { languageFromPath } from "./language-registry.js";
export type { AnalyzedFileIndex, CodeLanguage, IndexedCodeUnit, IndexedImport, LineIndex, ParsedFileIndex, SourceRange } from "./types.js";

const IDENTIFIER = /[A-Za-z_$][\w$]*|[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_-]+|\d+/g;
type SyntaxNode = ParserModule.SyntaxNode;

const TS_UNIT_KINDS = new Set([
	"function_declaration",
	"method_definition",
	"method_signature",
	"class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"variable_declaration",
	"variable_declarator",
]);
const PYTHON_UNIT_KINDS = new Set(["function_definition", "class_definition"]);
const GO_UNIT_KINDS = new Set(["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"]);
const RUST_UNIT_KINDS = new Set([
	"function_item",
	"function_signature_item",
	"struct_item",
	"enum_item",
	"type_item",
	"trait_item",
	"impl_item",
	"const_item",
	"static_item",
	"mod_item",
]);

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
	const rawUnits = parsed.units;
	const units = rawUnits.map((unit) => buildIndexedUnit(file, language, text, lineIndex, unit));
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
	const lineIndex = buildLineIndex(text);
	return lineForByteWithIndex(lineIndex, byteOffset);
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
	if (language === "text") return { status: "unsupported", units: [] };
	try {
		const runtime = loadTreeSitterRuntime(language);
		if (runtime === undefined) return { status: "error", units: [] };
		const parser = new runtime.Parser();
		parser.setLanguage(runtime.language);
		return { status: "parsed", units: collectTreeSitterUnits(language, parser.parse(text).rootNode).sort(compareRawUnits) };
	} catch {
		return { status: "error", units: [] };
	}
}

function collectFileImports(language: CodeLanguage, text: string, lineIndex: LineIndex): IndexedImport[] {
	const matches = language === "go" ? collectGoImports(text) : importPatterns(language).flatMap((pattern) => [...text.matchAll(pattern)]);
	const imports: IndexedImport[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		const specifier = match.groups?.["specifier"];
		const full = match[0];
		if (specifier === undefined || full === undefined || match.index === undefined) continue;
		const relativeStart = full.indexOf(specifier);
		if (relativeStart < 0) continue;
		const startChar = match.index + relativeStart;
		const endChar = startChar + specifier.length;
		const startByte = byteForCharWithIndex(text, lineIndex, startChar);
		const endByte = byteForCharWithIndex(text, lineIndex, endChar);
		const key = `${specifier}\0${startByte}\0${endByte}`;
		if (seen.has(key)) continue;
		seen.add(key);
		imports.push({
			specifier,
			startLine: lineForByteWithIndex(lineIndex, startByte),
			endLine: lineForByteWithIndex(lineIndex, Math.max(startByte, endByte - 1)),
			startByte,
			endByte,
		});
	}
	return imports.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte || (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0));
}

function importPatterns(language: CodeLanguage): RegExp[] {
	if (language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") {
		return [
			/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?["'](?<specifier>[^"']+)["']/gu,
			/\b(?:require|import)\s*\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu,
		];
	}
	if (language === "python") {
		return [
			/^\s*from\s+(?<specifier>[.A-Za-z_][\w.]*)\s+import\b/gmu,
			/^\s*import\s+(?<specifier>[A-Za-z_][\w.]*)/gmu,
		];
	}
	if (language === "rust") return [/\buse\s+(?<specifier>(?:::)?[A-Za-z_][\w:]*)/gu];
	return [];
}

function collectGoImports(text: string): RegExpMatchArray[] {
	const imports = [...text.matchAll(/\bimport\s+(?:[._A-Za-z]\w*\s+)?["'](?<specifier>[^"']+)["']/gu)];
	for (const block of text.matchAll(/\bimport\s*\((?<body>[\s\S]*?)\)/gu)) {
		const body = block.groups?.["body"];
		if (body === undefined || block.index === undefined) continue;
		const bodyStart = block.index + block[0].indexOf(body);
		for (const match of body.matchAll(/(?:^|\n)\s*(?:[._A-Za-z]\w*\s+)?["'](?<specifier>[^"']+)["']/gu)) {
			if (match.index !== undefined) match.index = bodyStart + match.index;
			imports.push(match);
		}
	}
	return imports;
}

function collectTreeSitterUnits(language: string, root: SyntaxNode): RawUnit[] {
	const units: RawUnit[] = [];
	walkUnits(language, root, undefined, units);
	return units;
}

function walkUnits(language: string, node: SyntaxNode, scope: string | undefined, units: RawUnit[]): void {
	const unit = rawTreeSitterUnit(language, node, scope);
	if (unit !== undefined) units.push(unit);
	if (unit !== undefined && !shouldDescendIntoUnit(language, node, unit)) return;
	const childScope = scopeFor(language, node, unit, scope);
	for (const child of node.namedChildren) {
		walkUnits(language, child, childScope, units);
	}
}

function rawTreeSitterUnit(language: string, node: SyntaxNode, scope: string | undefined): RawUnit | undefined {
	if (language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") return rawTsUnit(node, scope);
	if (language === "python") return rawPythonUnit(node, scope);
	if (language === "go") return rawGoUnit(node);
	if (language === "rust") return rawRustUnit(node, scope);
	return undefined;
}

function rawTsUnit(node: SyntaxNode, scope: string | undefined): RawUnit | undefined {
	if (!TS_UNIT_KINDS.has(node.type)) return undefined;
	const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "property_identifier", "type_identifier"]);
	if (name === undefined) return undefined;
	return rawUnit(node, normalizeTsKind(node.type), name, scope);
}

function normalizeTsKind(kind: string): string {
	if (kind === "function_declaration") return "function";
	if (kind === "method_definition") return "method";
	if (kind === "class_declaration") return "class";
	if (kind === "interface_declaration") return "interface";
	if (kind === "type_alias_declaration") return "type";
	if (kind === "enum_declaration") return "enum";
	if (kind === "variable_declarator") return "declaration";
	return "declaration";
}

function rawPythonUnit(node: SyntaxNode, scope: string | undefined): RawUnit | undefined {
	if (!PYTHON_UNIT_KINDS.has(node.type)) return undefined;
	const name = nameField(node);
	if (name === undefined) return undefined;
	return rawUnit(node, node.type === "class_definition" ? "class" : "function", name, scope);
}

function rawGoUnit(node: SyntaxNode): RawUnit | undefined {
	if (!GO_UNIT_KINDS.has(node.type)) return undefined;
	const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "field_identifier", "type_identifier"]);
	if (name === undefined) return undefined;
	return rawUnit(node, normalizeGoKind(node.type), name);
}

function normalizeGoKind(kind: string): string {
	if (kind === "function_declaration" || kind === "method_declaration") return "function";
	if (kind === "type_spec") return "type";
	return "declaration";
}

function rawRustUnit(node: SyntaxNode, scope: string | undefined): RawUnit | undefined {
	if (!RUST_UNIT_KINDS.has(node.type)) return undefined;
	const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "type_identifier"]);
	if (node.type === "impl_item" && name === undefined) return rawUnit(node, "module", "impl");
	if (name === undefined) return undefined;
	return rawUnit(node, normalizeRustKind(node.type), name, node.type === "function_item" || node.type === "function_signature_item" ? scope : undefined);
}

function normalizeRustKind(kind: string): string {
	if (kind === "function_item" || kind === "function_signature_item") return "function";
	if (kind === "struct_item" || kind === "enum_item" || kind === "type_item") return "type";
	if (kind === "trait_item") return "trait";
	if (kind === "impl_item" || kind === "mod_item") return "module";
	return "declaration";
}

function rawUnit(node: SyntaxNode, kind: string, name: string, scope?: string): RawUnit {
	const range = exportRangeNode(node);
	return {
		kind,
		name,
		qualifiedName: scope === undefined ? name : `${scope}.${name}`,
		startChar: range.startIndex,
		endChar: range.endIndex,
	};
}

function exportRangeNode(node: SyntaxNode): SyntaxNode {
	const parent = node.parent;
	return parent?.type === "export_statement" ? parent : node;
}

function scopeFor(language: string, node: SyntaxNode, unit: RawUnit | undefined, current: string | undefined): string | undefined {
	if (unit === undefined) return current;
	if ((language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") && unit.kind === "class") return unit.name ?? current;
	if (language === "python" && unit.kind === "class") return unit.name ?? current;
	if (language === "rust" && (node.type === "impl_item" || node.type === "trait_item")) return unit.name ?? current;
	return current;
}

function shouldDescendIntoUnit(language: string, node: SyntaxNode, unit: RawUnit): boolean {
	if ((language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") && (unit.kind === "class" || unit.kind === "interface")) return true;
	if (language === "python" && unit.kind === "class") return true;
	if (language === "rust" && (node.type === "impl_item" || node.type === "trait_item" || node.type === "mod_item")) return true;
	return false;
}

function nameField(node: SyntaxNode): string | undefined {
	return node.childForFieldName("name")?.text;
}

function firstNamedChildText(node: SyntaxNode, types: readonly string[]): string | undefined {
	return node.namedChildren.find((child) => types.includes(child.type))?.text;
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

function byteForCharWithIndex(text: string, index: LineIndex, charOffset: number): number {
	let low = 0;
	let high = index.lineStartChars.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const start = index.lineStartChars[middle] ?? 0;
		if (start <= charOffset) low = middle + 1;
		else high = middle - 1;
	}
	const line = Math.max(0, high);
	const lineStartChar = index.lineStartChars[line] ?? 0;
	const lineStartByte = index.lineStarts[line] ?? 0;
	return lineStartByte + Buffer.byteLength(text.slice(lineStartChar, charOffset), "utf8");
}

function lineForByteWithIndex(index: LineIndex, byteOffset: number): number {
	let low = 0;
	let high = index.lineStarts.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const start = index.lineStarts[middle] ?? 0;
		if (start <= byteOffset) low = middle + 1;
		else high = middle - 1;
	}
	return Math.max(1, high + 1);
}

function splitIdentifier(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.split(/[^A-Za-z0-9]+/u)
		.filter(Boolean);
}

function compareRawUnits(left: RawUnit, right: RawUnit): number {
	return left.startChar - right.startChar || left.endChar - right.endChar || left.kind.localeCompare(right.kind);
}
