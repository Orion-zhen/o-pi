import type { RequestType, RequestParam } from "vscode-jsonrpc/node";
import {
	CallHierarchyIncomingCallsRequest,
	CallHierarchyPrepareRequest,
	DocumentSymbolRequest,
	ReferencesRequest,
	WorkspaceSymbolRequest,
	WorkspaceSymbolResolveRequest,
	type CallHierarchyIncomingCall,
	type Location,
	type Position,
	type ServerCapabilities,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { LspDocumentSymbols, LspRequestOptions } from "../types.js";

/** 协议能力函数只依赖已建立连接的请求接口。 */
export interface LspFeatureSession {
	capabilities(): ServerCapabilities | undefined;
	request<P, R, E>(type: RequestType<P, R, E>, params: NoInfer<RequestParam<P>>, options?: LspRequestOptions): Promise<R | undefined>;
}

const providerEnabled = (provider: unknown): boolean => provider !== undefined && provider !== false;

export function supportsCodeAnalysis(capabilities: ServerCapabilities | undefined, related: boolean): boolean {
	return providerEnabled(capabilities?.documentSymbolProvider)
		&& providerEnabled(capabilities?.referencesProvider)
		&& providerEnabled(capabilities?.callHierarchyProvider)
		&& (!related || providerEnabled(capabilities?.workspaceSymbolProvider));
}

export async function requestDocumentSymbols(session: LspFeatureSession, uri: string, options?: LspRequestOptions): Promise<LspDocumentSymbols | undefined> {
	if (!providerEnabled(session.capabilities()?.documentSymbolProvider)) return undefined;
	const result = await session.request(DocumentSymbolRequest.type, { textDocument: { uri } }, options);
	return result === null ? [] : result as LspDocumentSymbols | undefined;
}

export async function requestWorkspaceSymbols(session: LspFeatureSession, query: string, options?: LspRequestOptions): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
	if (!providerEnabled(session.capabilities()?.workspaceSymbolProvider)) return undefined;
	const result = await session.request(WorkspaceSymbolRequest.type, { query }, options);
	return result === null ? [] : result as Array<SymbolInformation | WorkspaceSymbol> | undefined;
}

export async function resolveWorkspaceSymbol(session: LspFeatureSession, symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
	const provider = session.capabilities()?.workspaceSymbolProvider;
	if (typeof provider !== "object" || provider === null || provider.resolveProvider !== true) return undefined;
	return session.request(WorkspaceSymbolResolveRequest.type, symbol, options);
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
	return result === null ? [] : result;
}

export async function requestIncomingCalls(
	session: LspFeatureSession,
	uri: string,
	position: Position,
	options?: LspRequestOptions,
): Promise<CallHierarchyIncomingCall[] | undefined> {
	if (!providerEnabled(session.capabilities()?.callHierarchyProvider)) return undefined;
	const prepared = await session.request(CallHierarchyPrepareRequest.type, { textDocument: { uri }, position }, options);
	if (prepared === undefined) return undefined;
	const item = prepared?.[0];
	if (item === undefined) return [];
	const calls = await session.request(CallHierarchyIncomingCallsRequest.type, { item }, options);
	return calls === null ? [] : calls;
}
