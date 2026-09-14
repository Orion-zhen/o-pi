import type { Position } from "vscode-languageserver-protocol";

import { createFileIdentity, createSymbolId } from "../../code-index/identity.js";
import { languageFromPath } from "../../syntax-tree/grammars.js";
import { SourceIndex } from "../../code-index/source-index.js";
import { compactDeclaration } from "../../code-index/text.js";
import type { AnalyzedFileIndex, CodeDocument, IndexedCodeUnit } from "../../code-index/types.js";
import { normalizeDocumentSymbols, symbolKindName, type NormalizedDocumentSymbol } from "./symbols.js";
import type { LspDocumentSymbols } from "../types.js";

export interface AnalyzedLspUnit {
	readonly unit: IndexedCodeUnit;
	readonly position: Position;
}

export interface AnalyzedLspDocument {
	readonly analysis: AnalyzedFileIndex;
	readonly units: readonly AnalyzedLspUnit[];
}

/** 将 LSP documentSymbol 规范化为 grep/code-index 共用的代码单元。 */
export function analyzeLspDocument(document: CodeDocument, symbols: LspDocumentSymbols): AnalyzedLspDocument | undefined {
	const sourceIndex = new SourceIndex(document.text);
	const file = createFileIdentity(document.path);
	const units = new Map<string, AnalyzedLspUnit>();
	for (const symbol of normalizeDocumentSymbols(symbols)) {
		const unit = indexedUnit(document, sourceIndex, symbol, file.id);
		if (unit === undefined) return undefined;
		units.set(unit.id, { unit, position: symbol.selectionRange.start });
	}
	const values = [...units.values()].sort((left, right) =>
		left.unit.startByte - right.unit.startByte
		|| left.unit.endByte - right.unit.endByte
		|| compareString(left.unit.id, right.unit.id));
	return {
		analysis: {
			path: document.path,
			language: languageFromPath(document.path),
			units: values.map(({ unit }) => unit),
			status: "parsed",
			imports: [],
		},
		units: values,
	};
}

function indexedUnit(document: CodeDocument, sourceIndex: SourceIndex, symbol: NormalizedDocumentSymbol, fileId: string): IndexedCodeUnit | undefined {
	const startChar = charOffset(document.text, sourceIndex, symbol.range.start);
	const endChar = charOffset(document.text, sourceIndex, symbol.range.end);
	if (startChar === undefined || endChar === undefined || endChar < startChar) return undefined;
	const range = sourceIndex.range(startChar, endChar);
	const declaration = declarationAt(document.text, sourceIndex, symbol.range.start.line);
	const kind = symbolKindName(symbol.kind);
	return {
		id: createSymbolId({ fileId, kind, symbolName: symbol.qualifiedName ?? symbol.name, startByte: range.startByte }),
		path: document.path,
		kind,
		name: symbol.name,
		...(symbol.qualifiedName === undefined ? {} : { qualifiedName: symbol.qualifiedName }),
		...(declaration === undefined ? {} : { signature: declaration.text, declarationEndByte: declaration.endByte }),
		authority: "defined",
		exported: false,
		...range,
		definitions: [symbol.name],
		references: [],
		calls: [],
	};
}

function declarationAt(text: string, sourceIndex: SourceIndex, line: number): { readonly text: string; readonly endByte: number } | undefined {
	const start = sourceIndex.lineStartChars[line];
	if (start === undefined) return undefined;
	const next = sourceIndex.lineStartChars[line + 1] ?? text.length;
	const end = trimLineTerminator(text, start, next);
	const compact = compactDeclaration(text.slice(start, end));
	return compact.length === 0 ? undefined : { text: compact, endByte: sourceIndex.byteForChar(end) };
}

function charOffset(text: string, sourceIndex: SourceIndex, position: Position): number | undefined {
	const lineStart = sourceIndex.lineStartChars[position.line];
	if (lineStart === undefined) return undefined;
	const nextLine = sourceIndex.lineStartChars[position.line + 1] ?? text.length;
	const lineEnd = trimLineTerminator(text, lineStart, nextLine);
	const offset = lineStart + position.character;
	return offset <= lineEnd && !splitsSurrogatePair(text, offset) ? offset : undefined;
}

function trimLineTerminator(text: string, start: number, end: number): number {
	let value = end;
	if (value > start && text.charCodeAt(value - 1) === 0x0a) value -= 1;
	if (value > start && text.charCodeAt(value - 1) === 0x0d) value -= 1;
	return value;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return false;
	const left = text.charCodeAt(offset - 1);
	const right = text.charCodeAt(offset);
	return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
