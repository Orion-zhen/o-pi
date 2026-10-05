import {
	SymbolKind,
	type DocumentSymbol,
	type Location,
	type Range,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { LspDocumentSymbols } from "../types.ts";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.ts";

export interface WorkspaceSymbolSeed {
	path: string;
	symbol: string;
	qualified_symbol?: string;
	exact: boolean;
	range: Range;
}

export type NormalizedDocumentSymbol = {
	readonly name: string;
	readonly qualifiedName?: string;
	readonly kind: number;
	readonly range: Range;
	readonly parent?: NormalizedDocumentSymbol;
} & (
	| { readonly rangeKind: "extent"; readonly selectionRange: Range }
	| { readonly rangeKind: "location"; readonly uri: string }
);

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
export function normalizeDocumentSymbols(symbols: LspDocumentSymbols, parent?: NormalizedDocumentSymbol): NormalizedDocumentSymbol[] {
	const result: NormalizedDocumentSymbol[] = [];
	for (const symbol of symbols) {
		if (isDocumentSymbol(symbol)) {
			const value: NormalizedDocumentSymbol = {
				name: symbol.name, kind: symbol.kind, range: symbol.range, selectionRange: symbol.selectionRange,
				rangeKind: "extent",
				...(parent === undefined ? {} : { parent, qualifiedName: `${parent.qualifiedName ?? parent.name}.${symbol.name}` }),
			};
			result.push(value);
			if (symbol.children !== undefined) result.push(...normalizeDocumentSymbols(symbol.children, value));
		} else {
			const topLevel = symbol.containerName === undefined || symbol.containerName.trim().length === 0;
			result.push({
				name: symbol.name, kind: symbol.kind, range: symbol.location.range, rangeKind: "location", uri: symbol.location.uri,
				...(topLevel ? {} : { qualifiedName: `${symbol.containerName}.${symbol.name}` }),
			});
		}
	}
	return result;
}

export function workspaceSymbolSeed(root: string, query: string, symbol: SymbolInformation | WorkspaceSymbol): WorkspaceSymbolSeed | undefined {
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

export function workspaceSymbolLocation(symbol: SymbolInformation | WorkspaceSymbol): Location | undefined {
	return "range" in symbol.location ? symbol.location : undefined;
}

function isDocumentSymbol(value: DocumentSymbol | SymbolInformation): value is DocumentSymbol {
	return "range" in value && "selectionRange" in value;
}

export function symbolKindName(kind: number): string {
	return kindNames.get(kind) ?? `kind_${kind}`;
}

export function qualifiedSymbolName(symbol: SymbolInformation | WorkspaceSymbol): string | undefined {
	if (/[.:#]/u.test(symbol.name)) return symbol.name;
	if (symbol.containerName === undefined || symbol.containerName.trim().length === 0) return undefined;
	return `${symbol.containerName}.${symbol.name}`;
}

export function normalizeSymbolText(value: string): string {
	return value.replace(/::|#/gu, ".").toLocaleLowerCase();
}
