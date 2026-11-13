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

import type { LspDocumentSymbols, LspRequestOptions, LspRequestResult } from "../types.ts";

/** 能力检查、原始响应校验和结果分类只在协议边界执行。 */
export interface LspFeatureSession {
	capabilities(): ServerCapabilities;
	request<P, R, E>(type: RequestType<P, R, E>, params: NoInfer<RequestParam<P>>, options?: LspRequestOptions): Promise<LspRequestResult<R>>;
}

const providerEnabled = (provider: unknown): boolean => provider !== undefined && provider !== false;

export async function requestDocumentSymbols(session: LspFeatureSession, uri: string, options?: LspRequestOptions): Promise<LspRequestResult<LspDocumentSymbols>> {
	if (!providerEnabled(session.capabilities().documentSymbolProvider)) return { status: "unsupported" };
	const result = await session.request(DocumentSymbolRequest.type, { textDocument: { uri } }, options);
	if (result.status !== "ok") return result;
	const value: unknown = result.value;
	if (value === null) return { status: "ok", value: [] };
	if (!Array.isArray(value)) return { status: "unavailable" };
	const symbols: unknown[] = value;
	if (symbols.every(isDocumentSymbol) || symbols.every(isSymbolInformation)) return { status: "ok", value: symbols };
	return { status: "unavailable" };
}

export async function requestWorkspaceSymbols(session: LspFeatureSession, query: string, options?: LspRequestOptions): Promise<LspRequestResult<Array<SymbolInformation | WorkspaceSymbol>>> {
	if (!providerEnabled(session.capabilities().workspaceSymbolProvider)) return { status: "unsupported" };
	const result = await session.request(WorkspaceSymbolRequest.type, { query }, options);
	if (result.status !== "ok") return result;
	const value: unknown = result.value;
	if (value === null) return { status: "ok", value: [] };
	if (!Array.isArray(value)) return { status: "unavailable" };
	const symbols: unknown[] = value;
	return { status: "ok", value: symbols.filter(isWorkspaceSymbol) };
}

export async function resolveWorkspaceSymbol(session: LspFeatureSession, symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<LspRequestResult<WorkspaceSymbol>> {
	const provider = session.capabilities().workspaceSymbolProvider;
	if (typeof provider !== "object" || provider === null || provider.resolveProvider !== true) return { status: "unsupported" };
	const result = await session.request(WorkspaceSymbolResolveRequest.type, symbol, options);
	if (result.status !== "ok") return result;
	return isWorkspaceSymbol(result.value) ? { status: "ok", value: result.value } : { status: "unavailable" };
}

export async function requestReferences(
	session: LspFeatureSession,
	uri: string,
	position: Position,
	options?: LspRequestOptions,
): Promise<LspRequestResult<Location[]>> {
	if (!providerEnabled(session.capabilities().referencesProvider)) return { status: "unsupported" };
	const result = await session.request(ReferencesRequest.type, {
		textDocument: { uri }, position, context: { includeDeclaration: false },
	}, options);
	return resultArray(result, Location.is);
}

export async function prepareCalls(session: LspFeatureSession, uri: string, position: Position, options?: LspRequestOptions): Promise<LspRequestResult<CallHierarchyItem[]>> {
	if (!providerEnabled(session.capabilities().callHierarchyProvider)) return { status: "unsupported" };
	return resultArray(await session.request(CallHierarchyPrepareRequest.type, { textDocument: { uri }, position }, options), isHierarchyItem);
}

export async function requestIncomingCalls(session: LspFeatureSession, item: CallHierarchyItem, options?: LspRequestOptions): Promise<LspRequestResult<CallHierarchyIncomingCall[]>> {
	return resultArray(await session.request(CallHierarchyIncomingCallsRequest.type, { item }, options),
		(value): value is CallHierarchyIncomingCall => isRecord(value)
			&& isHierarchyItem(value.from) && isRanges(value.fromRanges) && rangesInside(value.fromRanges, value.from.range));
}

export async function requestOutgoingCalls(session: LspFeatureSession, item: CallHierarchyItem, options?: LspRequestOptions): Promise<LspRequestResult<CallHierarchyOutgoingCall[]>> {
	return resultArray(await session.request(CallHierarchyOutgoingCallsRequest.type, { item }, options),
		(value): value is CallHierarchyOutgoingCall => isRecord(value)
			&& isHierarchyItem(value.to) && isRanges(value.fromRanges) && rangesInside(value.fromRanges, item.range));
}

export async function requestDefinition(session: LspFeatureSession, uri: string, position: Position, options?: LspRequestOptions): Promise<LspRequestResult<readonly (Location | DefinitionLink)[]>> {
	if (!providerEnabled(session.capabilities().definitionProvider)) return { status: "unsupported" };
	const result = await session.request(DefinitionRequest.type, { textDocument: { uri }, position }, options);
	if (result.status !== "ok") return result;
	if (Location.is(result.value)) return { status: "ok", value: [result.value] };
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

function resultArray<T>(result: LspRequestResult<unknown>, valid: (item: unknown) => item is T): LspRequestResult<T[]> {
	if (result.status !== "ok") return result;
	if (result.value === null) return { status: "ok", value: [] };
	if (!Array.isArray(result.value)) return { status: "unavailable" };
	const items: unknown[] = result.value;
	return items.every(valid) ? { status: "ok", value: items } : { status: "unavailable" };
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
