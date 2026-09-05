import {
	SymbolKind,
	type DocumentSymbol,
	type Location,
	type Range,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { LspDocumentSymbols, LspEnclosingSymbol, LspRemainingSymbol } from "../types.js";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.js";

export interface WorkspaceSymbolSeed {
	path: string;
	symbol: string;
	qualified_symbol?: string;
	exact: boolean;
	range: Range;
}

export interface NormalizedDocumentSymbol {
	readonly name: string;
	readonly qualifiedName?: string;
	readonly kind: number;
	readonly range: Range;
	readonly selectionRange: Range;
	readonly topLevel: boolean;
}

const kindNames = new Map<number, string>([
	[SymbolKind.File, "file"],
	[SymbolKind.Module, "module"],
	[SymbolKind.Namespace, "namespace"],
	[SymbolKind.Package, "package"],
	[SymbolKind.Class, "class"],
	[SymbolKind.Method, "method"],
	[SymbolKind.Property, "property"],
	[SymbolKind.Field, "field"],
	[SymbolKind.Constructor, "constructor"],
	[SymbolKind.Enum, "enum"],
	[SymbolKind.Interface, "interface"],
	[SymbolKind.Function, "function"],
	[SymbolKind.Variable, "variable"],
	[SymbolKind.Constant, "constant"],
	[SymbolKind.String, "string"],
	[SymbolKind.Number, "number"],
	[SymbolKind.Boolean, "boolean"],
	[SymbolKind.Array, "array"],
	[SymbolKind.Object, "object"],
	[SymbolKind.Key, "key"],
	[SymbolKind.Null, "null"],
	[SymbolKind.EnumMember, "enum_member"],
	[SymbolKind.Struct, "struct"],
	[SymbolKind.Event, "event"],
	[SymbolKind.Operator, "operator"],
	[SymbolKind.TypeParameter, "type_parameter"],
]);

/** 在分析边界展开协议的两种符号形态，内部保留零基 UTF-16 范围。 */
export function normalizeDocumentSymbols(symbols: LspDocumentSymbols, parent?: string): NormalizedDocumentSymbol[] {
	const result: NormalizedDocumentSymbol[] = [];
	for (const symbol of symbols) {
		if (isDocumentSymbol(symbol)) {
			const qualifiedName = parent === undefined ? symbol.name : `${parent}.${symbol.name}`;
			result.push({
				name: symbol.name, kind: symbol.kind, range: symbol.range, selectionRange: symbol.selectionRange,
				topLevel: parent === undefined,
				...(parent === undefined ? {} : { qualifiedName }),
			});
			if (symbol.children !== undefined) result.push(...normalizeDocumentSymbols(symbol.children, qualifiedName));
		} else {
			const topLevel = symbol.containerName === undefined || symbol.containerName.trim().length === 0;
			result.push({
				name: symbol.name, kind: symbol.kind, range: symbol.location.range, selectionRange: symbol.location.range,
				topLevel,
				...(topLevel ? {} : { qualifiedName: `${symbol.containerName}.${symbol.name}` }),
			});
		}
	}
	return result;
}

/** 长文件截断时返回尚未出现在可见片段中的顶层符号。 */
export function remainingSymbols(
	symbols: LspDocumentSymbols | undefined,
	startLine: number,
	endLine: number,
	maxSymbols: number,
): LspRemainingSymbol[] {
	if (symbols === undefined || maxSymbols <= 0) return [];
	const topLevel = normalizeDocumentSymbols(symbols).filter((symbol) => symbol.topLevel).map(symbolSummary);
	const visibleCount = topLevel.filter((symbol) => symbol.line >= startLine && symbol.line <= endLine).length;
	if (visibleCount * 2 > topLevel.length) return [];
	return topLevel.filter((symbol) => symbol.line < startLine || symbol.line > endLine).slice(0, maxSymbols);
}

export function findEnclosingSymbol(symbols: LspDocumentSymbols | undefined, startLine: number, endLine: number): LspEnclosingSymbol | undefined {
	if (symbols === undefined) return undefined;
	const all = normalizeDocumentSymbols(symbols).map(symbolSummary).filter((symbol) => symbol.line <= startLine && symbol.end_line >= endLine);
	all.sort((left, right) => (left.end_line - left.line) - (right.end_line - right.line));
	const found = all[0];
	return found === undefined || found.line >= startLine ? undefined : found;
}

export function modifiedSymbolRanges(
	symbols: LspDocumentSymbols | undefined,
	changedRanges: readonly { startLine: number; endLine: number }[],
): LspEnclosingSymbol[] {
	if (symbols === undefined || changedRanges.length === 0) return [];
	const all = normalizeDocumentSymbols(symbols).map(symbolSummary);
	const selected = new Map<string, LspEnclosingSymbol>();
	for (const changed of changedRanges) {
		const candidates = all
			.filter((symbol) => symbol.line <= changed.endLine && symbol.end_line >= changed.startLine)
			.sort((left, right) => (left.end_line - left.line) - (right.end_line - right.line));
		const found = candidates[0];
		if (found !== undefined) selected.set(`${found.line}:${found.end_line}:${found.name}`, found);
	}
	return [...selected.values()];
}

export function workspaceSymbolSeed(root: string, query: string, symbol: SymbolInformation | WorkspaceSymbol): WorkspaceSymbolSeed | undefined {
	if (typeof symbol.name !== "string" || typeof symbol.kind !== "number") return undefined;
	const location = workspaceSymbolLocation(symbol);
	if (location === undefined) return undefined;
	const filePath = fileUriToPath(location.uri);
	if (filePath === undefined) return undefined;
	const relative = workspaceRelativePath(root, filePath);
	if (relative === undefined) return undefined;
	const qualifiedSymbol = qualifiedSymbolName(symbol);
	const normalizedQuery = normalizeSymbolText(query);
	return {
		path: relative, symbol: symbol.name, range: location.range,
		...(qualifiedSymbol === undefined ? {} : { qualified_symbol: qualifiedSymbol }),
		exact: normalizeSymbolText(symbol.name) === normalizedQuery
			|| (qualifiedSymbol !== undefined && normalizeSymbolText(qualifiedSymbol) === normalizedQuery),
	};
}

function symbolSummary(symbol: NormalizedDocumentSymbol): LspRemainingSymbol {
	return {
		name: symbol.name, kind: symbolKindName(symbol.kind),
		line: symbol.range.start.line + 1, end_line: symbol.range.end.line + 1,
	};
}

export function workspaceSymbolLocation(symbol: unknown): Location | undefined {
	return isRecord(symbol) ? validLocation(symbol.location) : undefined;
}

function validLocation(value: unknown): Location | undefined {
	if (!isRecord(value) || typeof value.uri !== "string" || !isValidRange(value.range)) return undefined;
	return { uri: value.uri, range: value.range };
}

export function hasUriOnlyWorkspaceSymbolLocation(symbol: unknown): symbol is WorkspaceSymbol {
	if (!isRecord(symbol)) return false;
	const location = symbol.location;
	return isRecord(location) && typeof location.uri === "string" && !("range" in location);
}

function isValidRange(value: unknown): value is Range {
	if (!isRecord(value) || !isValidPosition(value.start) || !isValidPosition(value.end)) return false;
	return value.start.line < value.end.line
		|| (value.start.line === value.end.line && value.start.character <= value.end.character);
}

function isValidPosition(value: unknown): value is { line: number; character: number } {
	if (!isRecord(value)) return false;
	const { line, character } = value;
	return typeof line === "number" && Number.isInteger(line) && line >= 0
		&& typeof character === "number" && Number.isInteger(character) && character >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isDocumentSymbol(value: DocumentSymbol | SymbolInformation): value is DocumentSymbol {
	return "range" in value && "selectionRange" in value;
}

export function symbolKindName(kind: number): string {
	return kindNames.get(kind) ?? `kind_${kind}`;
}

export function qualifiedSymbolName(symbol: SymbolInformation | WorkspaceSymbol): string | undefined {
	if (/[.:#]/u.test(symbol.name)) return symbol.name;
	if (typeof symbol.containerName !== "string" || symbol.containerName.trim().length === 0) return undefined;
	return `${symbol.containerName}.${symbol.name}`;
}

export function normalizeSymbolText(value: string): string {
	return value.replace(/::|#/gu, ".").toLocaleLowerCase();
}
