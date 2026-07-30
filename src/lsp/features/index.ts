import type { RequestType } from "vscode-jsonrpc/node";
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
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type {
	LspDocumentSymbols,
	LspRequestOptions,
	LspServerCapabilities,
} from "../types.js";
import { requestTypeScriptDiagnostics, typescriptDiagnosticsAvailable } from "./typescript-diagnostics.js";

/** feature adapter 使用的最小 session 协议。 */
export interface LspFeatureSession {
	capabilities(): LspServerCapabilities | undefined;
	request<P, R, E>(type: RequestType<P, R, E>, params: P, options?: LspRequestOptions): Promise<R | undefined>;
}

export interface LspFeatureDefinition {
	readonly id:
		| "documentSymbols"
		| "workspaceSymbols"
		| "workspaceSymbolResolve"
		| "references"
		| "incomingCalls"
		| "typescriptDiagnostics";
	readonly capability: (capabilities: LspServerCapabilities | undefined) => boolean;
}

const providerEnabled = (provider: unknown): boolean => provider !== undefined && provider !== false;

export const lspFeatureDefinitions = {
	documentSymbols: {
		id: "documentSymbols",
		capability: (capabilities) => providerEnabled(capabilities?.documentSymbolProvider),
	},
	workspaceSymbols: {
		id: "workspaceSymbols",
		capability: (capabilities) => providerEnabled(capabilities?.workspaceSymbolProvider),
	},
	workspaceSymbolResolve: {
		id: "workspaceSymbolResolve",
		capability: (capabilities) => {
			const provider = capabilities?.workspaceSymbolProvider;
			return typeof provider === "object" && provider !== null && provider.resolveProvider === true;
		},
	},
	references: {
		id: "references",
		capability: (capabilities) => providerEnabled(capabilities?.referencesProvider),
	},
	incomingCalls: {
		id: "incomingCalls",
		capability: (capabilities) => providerEnabled(capabilities?.callHierarchyProvider),
	},
	typescriptDiagnostics: {
		id: "typescriptDiagnostics",
		capability: typescriptDiagnosticsAvailable,
	},
} as const satisfies Readonly<Record<string, LspFeatureDefinition>>;

export function featureAvailable(session: LspFeatureSession, feature: LspFeatureDefinition): boolean {
	return feature.capability(session.capabilities());
}

export async function requestDocumentSymbols(session: LspFeatureSession, uri: string, options?: LspRequestOptions): Promise<LspDocumentSymbols | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.documentSymbols)) return undefined;
	const result = await session.request(DocumentSymbolRequest.type, { textDocument: { uri } }, options);
	return result === null ? [] : result as LspDocumentSymbols | undefined;
}

export async function requestWorkspaceSymbols(session: LspFeatureSession, query: string, options?: LspRequestOptions): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.workspaceSymbols)) return undefined;
	const result = await session.request(WorkspaceSymbolRequest.type, { query }, options);
	return result === null ? [] : result as Array<SymbolInformation | WorkspaceSymbol> | undefined;
}

export async function resolveWorkspaceSymbol(session: LspFeatureSession, symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.workspaceSymbolResolve)) return undefined;
	return session.request(WorkspaceSymbolResolveRequest.type, symbol, options);
}

export async function requestReferences(
	session: LspFeatureSession,
	uri: string,
	position: Position,
	options?: LspRequestOptions,
): Promise<Location[] | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.references)) return undefined;
	const result = await session.request(ReferencesRequest.type, {
		textDocument: { uri },
		position,
		context: { includeDeclaration: false },
	}, options);
	return result === null ? [] : result;
}

export async function requestIncomingCalls(
	session: LspFeatureSession,
	uri: string,
	position: Position,
	options?: LspRequestOptions,
): Promise<CallHierarchyIncomingCall[] | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.incomingCalls)) return undefined;
	const prepared = await session.request(CallHierarchyPrepareRequest.type, {
		textDocument: { uri },
		position,
	}, options);
	if (prepared === undefined) return undefined;
	if (prepared === null || prepared.length === 0) return [];
	const item = prepared[0];
	if (item === undefined) return [];
	const calls = await session.request(CallHierarchyIncomingCallsRequest.type, { item }, options);
	return calls === null ? [] : calls;
}

/** 后续 feature 只需在此边界注册 adapter，不改 transport、registry 或 manager 生命周期。 */
export const lspFeatureAdapters = {
	documentSymbols: requestDocumentSymbols,
	workspaceSymbols: requestWorkspaceSymbols,
	workspaceSymbolResolve: resolveWorkspaceSymbol,
	references: requestReferences,
	incomingCalls: requestIncomingCalls,
	typescriptDiagnostics: requestTypeScriptDiagnostics,
};

export { requestTypeScriptDiagnostics };
export type LspFeatureRequest = typeof lspFeatureAdapters;
