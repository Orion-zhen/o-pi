import path from "node:path";
import {
	SymbolKind,
	type DocumentSymbol,
	type Location,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { LspDocumentSymbols, LspEnclosingSymbol, LspOutlineItem, LspSymbolHit } from "./types.js";
import { fileUriToPath, workspaceRelativePath } from "./uri.js";

interface WorkspaceSymbolSeed extends LspSymbolHit {
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

/** 将 documentSymbol 结果压缩为 read 可返回的 outline。 */
export function compactOutline(symbols: LspDocumentSymbols | undefined, maxSymbols: number): LspOutlineItem[] {
	if (symbols === undefined || maxSymbols <= 0) return [];
	const output: LspOutlineItem[] = [];
	for (const item of symbols) {
		if (output.length >= maxSymbols) break;
		if (isDocumentSymbol(item)) {
			output.push(toOutline(item, maxSymbols, output));
		} else {
			output.push({
				name: item.name,
				kind: symbolKindName(item.kind),
				line: item.location.range.start.line + 1,
				end_line: item.location.range.end.line + 1,
			});
		}
	}
	return output.slice(0, maxSymbols);
}

export function findEnclosingSymbol(symbols: LspDocumentSymbols | undefined, startLine: number, endLine: number): LspEnclosingSymbol | undefined {
	if (symbols === undefined) return undefined;
	const all = flattenDocumentSymbols(symbols).filter((symbol) => symbol.line <= startLine && symbol.end_line >= endLine);
	all.sort((left, right) => (left.end_line - left.line) - (right.end_line - right.line));
	const found = all[0];
	return found === undefined ? undefined : found;
}

export function workspaceSymbolHits(root: string, query: string, symbols: Array<SymbolInformation | WorkspaceSymbol> | undefined, maxItems: number): LspSymbolHit[] {
	return workspaceSymbolSeeds(root, query, symbols, maxItems).map(({ uri: _uri, line: _line, character: _character, ...hit }) => hit);
}

export function workspaceSymbolSeeds(root: string, query: string, symbols: Array<SymbolInformation | WorkspaceSymbol> | undefined, maxItems: number): WorkspaceSymbolSeed[] {
	if (symbols === undefined || maxItems <= 0) return [];
	const queryLower = query.toLocaleLowerCase();
	const hits: WorkspaceSymbolSeed[] = [];
	for (const symbol of symbols) {
		if (hits.length >= maxItems) break;
		const location = symbolLocation(symbol);
		if (location === undefined) continue;
		const filePath = fileUriToPath(location.uri);
		if (filePath === undefined) continue;
		const relative = workspaceRelativePath(root, filePath);
		if (relative === undefined) continue;
		hits.push({
			path: relative,
			start_line: location.range.start.line + 1,
			end_line: location.range.end.line + 1,
			kind: symbolKindName(symbol.kind),
			symbol: symbol.name,
			exact: symbol.name.toLocaleLowerCase() === queryLower,
			uri: location.uri,
			line: location.range.start.line,
			character: location.range.start.character,
		});
	}
	return hits;
}

export function referenceHits(root: string, seed: WorkspaceSymbolSeed, locations: readonly Location[], maxItems: number): LspSymbolHit[] {
	const hits: LspSymbolHit[] = [];
	for (const location of locations) {
		if (hits.length >= maxItems) break;
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
		});
	}
	return hits;
}

function toOutline(symbol: DocumentSymbol, maxSymbols: number, used: LspOutlineItem[]): LspOutlineItem {
	const item: LspOutlineItem = {
		name: symbol.name,
		kind: symbolKindName(symbol.kind),
		line: symbol.range.start.line + 1,
		end_line: symbol.range.end.line + 1,
	};
	if (symbol.detail !== undefined && symbol.detail.length > 0) item.detail = symbol.detail;
	if (symbol.children !== undefined && symbol.children.length > 0 && used.length < maxSymbols) {
		const children: LspOutlineItem[] = [];
		for (const child of symbol.children) {
			if (used.length + children.length >= maxSymbols) break;
			children.push(toOutline(child, maxSymbols, used));
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

function symbolLocation(symbol: SymbolInformation | WorkspaceSymbol): Location | undefined {
	const location = symbol.location;
	if (location === undefined) return undefined;
	if ("uri" in location && "range" in location) return location;
	return undefined;
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
