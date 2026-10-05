import type { RequestType, RequestParam } from "vscode-jsonrpc/node";
import {
	CallHierarchyIncomingCallsRequest,
	CallHierarchyOutgoingCallsRequest,
	CallHierarchyPrepareRequest,
	DefinitionRequest,
	Location,
	LocationLink,
	Range,
	DocumentSymbol,
	DocumentSymbolRequest,
	ReferencesRequest,
	WorkspaceSymbolRequest,
	WorkspaceSymbolResolveRequest,
	type CallHierarchyIncomingCall,
	type CallHierarchyOutgoingCall,
	type CallHierarchyItem,
	type DefinitionLink,
	type Position,
	type ServerCapabilities,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { LspDocumentSymbols, LspRequestOptions } from "../types.ts";

/** 协议能力函数只依赖已建立连接的请求接口。 */
export interface LspFeatureSession {
	capabilities(): ServerCapabilities | undefined;
	request<P, R, E>(type: RequestType<P, R, E>, params: NoInfer<RequestParam<P>>, options?: LspRequestOptions): Promise<R | undefined>;
}

export const providerEnabled = (provider: unknown): boolean => provider !== undefined && provider !== false;

export async function requestDocumentSymbols(session: LspFeatureSession, uri: string, options?: LspRequestOptions): Promise<LspDocumentSymbols | undefined> {
	if (!providerEnabled(session.capabilities()?.documentSymbolProvider)) return undefined;
	const result: unknown = await session.request(DocumentSymbolRequest.type, { textDocument: { uri } }, options);
	if (result === null) return [];
	if (!Array.isArray(result)) return undefined;
	const symbols: unknown[] = result;
	if (symbols.every(isDocumentSymbol)) return symbols;
	return symbols.every(isSymbolInformation) ? symbols : undefined;
}

export async function requestWorkspaceSymbols(session: LspFeatureSession, query: string, options?: LspRequestOptions): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
	if (!providerEnabled(session.capabilities()?.workspaceSymbolProvider)) return undefined;
	const result: unknown = await session.request(WorkspaceSymbolRequest.type, { query }, options);
	if (result === null) return [];
	if (!Array.isArray(result)) return undefined;
	const symbols: unknown[] = result;
	return symbols.filter(isWorkspaceSymbol);
}

export async function resolveWorkspaceSymbol(session: LspFeatureSession, symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
	const provider = session.capabilities()?.workspaceSymbolProvider;
	if (typeof provider !== "object" || provider === null || provider.resolveProvider !== true) return undefined;
	const result: unknown = await session.request(WorkspaceSymbolResolveRequest.type, symbol, options);
	return isWorkspaceSymbol(result) ? result : undefined;
}

export async function requestReferences(
	session: LspFeatureSession,
	uri: string,
	position: Position,
	options?: LspRequestOptions,
): Promise<Location[] | undefined> {
	if (!providerEnabled(session.capabilities()?.referencesProvider)) return undefined;
	const result = await session.request(ReferencesRequest.type, {
		textDocument: { uri }, position, context: { includeDeclaration: false },
	}, options);
	return resultArray(result, Location.is);
}

export async function prepareCalls(session: LspFeatureSession, uri: string, position: Position, options?: LspRequestOptions): Promise<CallHierarchyItem[] | undefined> {
	if (!providerEnabled(session.capabilities()?.callHierarchyProvider)) return undefined;
	const result: unknown = await session.request(CallHierarchyPrepareRequest.type, { textDocument: { uri }, position }, options);
	return resultArray(result, isHierarchyItem);
}

export async function requestIncomingCalls(session: LspFeatureSession, item: CallHierarchyItem, options?: LspRequestOptions): Promise<CallHierarchyIncomingCall[] | undefined> {
	const result: unknown = await session.request(CallHierarchyIncomingCallsRequest.type, { item }, options);
	return resultArray(result, (value): value is CallHierarchyIncomingCall => isRecord(value)
		&& isHierarchyItem(value.from) && isRanges(value.fromRanges) && rangesInside(value.fromRanges, value.from.range));
}

export async function requestOutgoingCalls(session: LspFeatureSession, item: CallHierarchyItem, options?: LspRequestOptions): Promise<CallHierarchyOutgoingCall[] | undefined> {
	const result: unknown = await session.request(CallHierarchyOutgoingCallsRequest.type, { item }, options);
	return resultArray(result, (value): value is CallHierarchyOutgoingCall => isRecord(value)
		&& isHierarchyItem(value.to) && isRanges(value.fromRanges) && rangesInside(value.fromRanges, item.range));
}

export async function requestDefinition(session: LspFeatureSession, uri: string, position: Position, options?: LspRequestOptions): Promise<readonly (Location | DefinitionLink)[] | undefined> {
	if (!providerEnabled(session.capabilities()?.definitionProvider)) return undefined;
	const result: unknown = await session.request(DefinitionRequest.type, { textDocument: { uri }, position }, options);
	if (Location.is(result)) return [result];
	return resultArray(result, (value): value is Location | DefinitionLink => Location.is(value)
		|| LocationLink.is(value) && containsPositionRange(value.targetRange, value.targetSelectionRange));
}

function isDocumentSymbol(value: unknown): value is DocumentSymbol {
	return DocumentSymbol.is(value) && (value.children === undefined || value.children.every(isDocumentSymbol));
}

function isWorkspaceSymbol(value: unknown): value is WorkspaceSymbol {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.kind !== "number"
		|| value.containerName !== undefined && typeof value.containerName !== "string") return false;
	const location = value.location;
	if (!isRecord(location) || typeof location.uri !== "string") return false;
	if (!("range" in location)) return true;
	const range = location.range;
	return Range.is(range) && (range.start.line < range.end.line
		|| range.start.line === range.end.line && range.start.character <= range.end.character);
}

function isSymbolInformation(value: unknown): value is SymbolInformation {
	return isWorkspaceSymbol(value) && "range" in value.location;
}

function resultArray<T>(value: unknown, valid: (item: unknown) => item is T): T[] | undefined {
	if (value === null) return [];
	if (!Array.isArray(value)) return undefined;
	const items: unknown[] = value;
	return items.every(valid) ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHierarchyItem(value: unknown): value is CallHierarchyItem {
	return isRecord(value) && typeof value.name === "string" && typeof value.uri === "string"
		&& Number.isInteger(value.kind) && Range.is(value.range) && Range.is(value.selectionRange)
		&& containsPositionRange(value.range, value.selectionRange);
}

function isRanges(value: unknown): value is Range[] {
	return Array.isArray(value) && value.every((item: unknown) => Range.is(item));
}

function rangesInside(ranges: readonly Range[], outer: Range): boolean {
	return ranges.every((range) => containsPositionRange(outer, range));
}

function containsPositionRange(outer: Range, inner: Range): boolean {
	const compare = (left: Position, right: Position) => left.line - right.line || left.character - right.character;
	return compare(outer.start, inner.start) <= 0 && compare(inner.start, inner.end) <= 0 && compare(inner.end, outer.end) <= 0;
}
