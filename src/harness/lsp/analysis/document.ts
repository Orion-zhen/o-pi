import type { Position, Range } from "vscode-languageserver-protocol";

import { createFileIdentity, createSymbolId } from "../../code-index/identity.ts";
import { languageFromPath } from "../../syntax-tree/grammars.ts";
import { SourceIndex } from "../../code-index/source-index.ts";
import { compactDeclaration } from "../../code-index/text.ts";
import type { AnalyzedFileIndex, CodeDocument, IndexedCodeUnit } from "../../code-index/types.ts";
import { normalizeDocumentSymbols, symbolKindName, type NormalizedDocumentSymbol } from "./symbols.ts";
import type { LspDocumentSymbols } from "../types.ts";
import { fileUriToPath } from "../protocol/uri.ts";

/** 将 LSP documentSymbol 规范化为 grep/code-index 共用的代码单元。 */
export function analyzeLspDocument(document: Pick<CodeDocument, "path" | "text">, symbols: LspDocumentSymbols, documentUri: string): AnalyzedFileIndex | undefined {
	const sourceIndex = new SourceIndex(document.text);
	const file = createFileIdentity(document.path);
	const documentPath = fileUriToPath(documentUri);
	const units = new Map<string, IndexedCodeUnit>();
	const ids = new Map<NormalizedDocumentSymbol, string>();
	for (const symbol of normalizeDocumentSymbols(symbols)) {
		if (symbol.rangeKind === "location" && fileUriToPath(symbol.uri) !== documentPath) continue;
		const parentId = symbol.parent === undefined ? undefined : ids.get(symbol.parent);
		const unit = indexedUnit(document, sourceIndex, symbol, file.id, parentId);
		if (unit === undefined) return undefined;
		ids.set(symbol, unit.id);
		units.set(unit.id, unit);
	}
	return {
		path: document.path,
		language: languageFromPath(document.path),
		units: [...units.values()].sort((left, right) => left.startByte - right.startByte
			|| left.endByte - right.endByte || compareString(left.id, right.id)),
		status: "parsed",
	};
}

function indexedUnit(document: Pick<CodeDocument, "path" | "text">, sourceIndex: SourceIndex, symbol: NormalizedDocumentSymbol, fileId: string, parentId?: string): (IndexedCodeUnit & { name: string }) | undefined {
	const startChar = charOffset(document.text, sourceIndex, symbol.range.start);
	const endChar = charOffset(document.text, sourceIndex, symbol.range.end);
	if (startChar === undefined || endChar === undefined || endChar < startChar) return undefined;
	const range = sourceIndex.range(startChar, endChar);
	const declaration = declarationAt(document.text, sourceIndex, symbol.range.start.line);
	const kind = symbolKindName(symbol.kind);
	const selection = symbol.rangeKind === "extent" ? sourceRange(document.text, sourceIndex, symbol.selectionRange) : undefined;
	if (symbol.rangeKind === "extent" && (selection === undefined || selection.startByte < range.startByte || selection.endByte > range.endByte)) return undefined;
	return {
		id: `lsp:${createSymbolId({ fileId, kind, symbolName: symbol.qualifiedName ?? symbol.name, startByte: range.startByte })}`,
		path: document.path,
		kind,
		name: symbol.name,
		...(symbol.qualifiedName === undefined ? {} : { qualifiedName: symbol.qualifiedName }),
		...(declaration === undefined ? {} : { signature: declaration.text, declarationEndByte: declaration.endByte }),
		authority: "defined",
		...range,
		...(parentId === undefined ? {} : { parentId }),
		symbol: {
			...(selection === undefined ? { type: "location" } : { type: "document", selection }),
			range,
			...(parentId === undefined ? {} : { parentId }),
		},
	};
}

export function sourceRange(text: string, index: SourceIndex, range: Range) {
	const start = charOffset(text, index, range.start);
	const end = charOffset(text, index, range.end);
	return start === undefined || end === undefined || end < start ? undefined : index.range(start, end);
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
	if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return undefined;
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
