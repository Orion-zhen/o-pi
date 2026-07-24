import path from "node:path";
import {
	SymbolKind,
	type DocumentSymbol,
	type Location,
	type Range,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { LspDocumentSymbols, LspEnclosingSymbol, LspOutlineItem, LspSymbolHit } from "./types.js";
import { fileUriToPath, workspaceRelativePath } from "./uri.js";

export interface WorkspaceSymbolSeed extends LspSymbolHit {
	uri: string;
	line: number;
	character: number;
}

export interface ReferenceHit extends LspSymbolHit {
	uri: string;
	line: number;
	character: number;
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

/** 将 documentSymbol 结果按稳定 DFS 压缩为受全树预算限制的 outline。 */
export function compactOutline(symbols: LspDocumentSymbols | undefined, maxSymbols: number): LspOutlineItem[] {
	if (symbols === undefined || maxSymbols <= 0) return [];
	const budget = { remaining: maxSymbols };
	const output: LspOutlineItem[] = [];
	for (const symbol of symbols) {
		if (budget.remaining <= 0) break;
		if (isDocumentSymbol(symbol)) {
			output.push(toOutline(symbol, budget));
			continue;
		}
		budget.remaining -= 1;
		output.push({
			name: symbol.name,
			kind: symbolKindName(symbol.kind),
			line: symbol.location.range.start.line + 1,
			end_line: symbol.location.range.end.line + 1,
		});
	}
	return output;
}

export function findEnclosingSymbol(symbols: LspDocumentSymbols | undefined, startLine: number, endLine: number): LspEnclosingSymbol | undefined {
	if (symbols === undefined) return undefined;
	const all = flattenDocumentSymbols(symbols).filter((symbol) => symbol.line <= startLine && symbol.end_line >= endLine);
	all.sort((left, right) => (left.end_line - left.line) - (right.end_line - right.line));
	const found = all[0];
	return found === undefined ? undefined : found;
}

export function workspaceSymbolSeed(root: string, query: string, symbol: SymbolInformation | WorkspaceSymbol): WorkspaceSymbolSeed | undefined {
	if (typeof symbol.name !== "string" || typeof symbol.kind !== "number") return undefined;
	const location = workspaceSymbolLocation(symbol);
	if (location === undefined) return undefined;
	const filePath = fileUriToPath(location.uri);
	if (filePath === undefined) return undefined;
	const relative = workspaceRelativePath(root, filePath);
	if (relative === undefined) return undefined;
	return {
		path: relative,
		start_line: location.range.start.line + 1,
		end_line: location.range.end.line + 1,
		kind: symbolKindName(symbol.kind),
		symbol: symbol.name,
		exact: symbol.name.toLocaleLowerCase() === query.toLocaleLowerCase(),
		origin: "workspace-symbol",
		uri: location.uri,
		line: location.range.start.line,
		character: location.range.start.character,
	};
}

export function referenceHits(root: string, seed: WorkspaceSymbolSeed, locations: readonly Location[]): ReferenceHit[] {
	const hits: ReferenceHit[] = [];
	for (const rawLocation of locations) {
		const location = validLocation(rawLocation);
		if (location === undefined) continue;
		const filePath = fileUriToPath(location.uri);
		if (filePath === undefined) continue;
		const relative = workspaceRelativePath(root, filePath);
		if (relative === undefined) continue;
		hits.push({
			path: relative,
			start_line: location.range.start.line + 1,
			end_line: location.range.end.line + 1,
			kind: seed.kind,
			symbol: seed.symbol,
			exact: false,
			origin: "reference",
			uri: location.uri,
			line: location.range.start.line,
			character: location.range.start.character,
		});
	}
	return hits;
}

function toOutline(symbol: DocumentSymbol, budget: { remaining: number }): LspOutlineItem {
	budget.remaining -= 1;
	const item: LspOutlineItem = {
		name: symbol.name,
		kind: symbolKindName(symbol.kind),
		line: symbol.range.start.line + 1,
		end_line: symbol.range.end.line + 1,
	};
	if (symbol.detail !== undefined && symbol.detail.length > 0) item.detail = symbol.detail;
	if (symbol.children !== undefined && budget.remaining > 0) {
		const children: LspOutlineItem[] = [];
		for (const child of symbol.children) {
			if (budget.remaining <= 0) break;
			children.push(toOutline(child, budget));
		}
		if (children.length > 0) item.children = children;
	}
	return item;
}

function flattenDocumentSymbols(symbols: LspDocumentSymbols): LspEnclosingSymbol[] {
	const result: LspEnclosingSymbol[] = [];
	for (const symbol of symbols) {
		if (isDocumentSymbol(symbol)) {
			result.push({
				name: symbol.name,
				kind: symbolKindName(symbol.kind),
				line: symbol.range.start.line + 1,
				end_line: symbol.range.end.line + 1,
				...(symbol.detail !== undefined ? { detail: symbol.detail } : {}),
			});
			if (symbol.children !== undefined) result.push(...flattenDocumentSymbols(symbol.children));
		} else {
			result.push({
				name: symbol.name,
				kind: symbolKindName(symbol.kind),
				line: symbol.location.range.start.line + 1,
				end_line: symbol.location.range.end.line + 1,
			});
		}
	}
	return result;
}

export function workspaceSymbolLocation(symbol: unknown): Location | undefined {
	return isRecord(symbol) ? validLocation(symbol.location) : undefined;
}

export function validLocation(value: unknown): Location | undefined {
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
	return typeof line === "number"
		&& Number.isInteger(line)
		&& line >= 0
		&& typeof character === "number"
		&& Number.isInteger(character)
		&& character >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isDocumentSymbol(value: DocumentSymbol | SymbolInformation): value is DocumentSymbol {
	return "range" in value && "selectionRange" in value;
}

function symbolKindName(kind: number): string {
	return kindNames.get(kind) ?? `kind_${kind}`;
}

export function extensionForPath(filePath: string): string {
	return path.extname(filePath).toLowerCase();
}
