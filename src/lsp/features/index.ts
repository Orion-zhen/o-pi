import type { RequestType } from "vscode-jsonrpc/node";
import {
	DocumentSymbolRequest,
	ReferencesRequest,
	WorkspaceSymbolRequest,
	WorkspaceSymbolResolveRequest,
	type Location,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type {
	LspDocumentSymbols,
	LspRequestOptions,
	LspServerCapabilities,
} from "../types.js";
import { pathToFileUri } from "../uri.js";

/** feature adapter 使用的最小 session 协议。 */
export interface LspFeatureSession {
	capabilities(): LspServerCapabilities | undefined;
	didOpenOrChange(filePath: string, text: string): Promise<boolean>;
	request<P, R, E>(type: RequestType<P, R, E>, params: P, options?: LspRequestOptions): Promise<R | undefined>;
}

export interface LspFeatureDefinition {
	readonly id: "documentSymbols" | "workspaceSymbols" | "workspaceSymbolResolve" | "references";
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
} as const satisfies Readonly<Record<string, LspFeatureDefinition>>;

export function featureAvailable(session: LspFeatureSession, feature: LspFeatureDefinition): boolean {
	return feature.capability(session.capabilities());
}

export async function requestDocumentSymbols(session: LspFeatureSession, filePath: string, text: string, options?: LspRequestOptions): Promise<LspDocumentSymbols | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.documentSymbols)) return undefined;
	if (!await session.didOpenOrChange(filePath, text)) return undefined;
	const result = await session.request(DocumentSymbolRequest.type, { textDocument: { uri: pathToFileUri(filePath) } }, options);
	return result === null ? undefined : result as LspDocumentSymbols | undefined;
}

export async function requestWorkspaceSymbols(session: LspFeatureSession, query: string, options?: LspRequestOptions): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.workspaceSymbols)) return undefined;
	const result = await session.request(WorkspaceSymbolRequest.type, { query }, options);
	return result === null ? undefined : result as Array<SymbolInformation | WorkspaceSymbol> | undefined;
}

export async function resolveWorkspaceSymbol(session: LspFeatureSession, symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.workspaceSymbolResolve)) return undefined;
	return session.request(WorkspaceSymbolResolveRequest.type, symbol, options);
}

export async function requestReferences(session: LspFeatureSession, uri: string, line: number, character: number, options?: LspRequestOptions): Promise<Location[] | undefined> {
	if (!featureAvailable(session, lspFeatureDefinitions.references)) return undefined;
	const result = await session.request(ReferencesRequest.type, {
		textDocument: { uri },
		position: { line, character },
		context: { includeDeclaration: false },
	}, options);
	return result === null ? undefined : result as Location[] | undefined;
}

/** 后续 feature 只需在此边界注册 adapter，不改 transport、registry 或 manager 生命周期。 */
export const lspFeatureAdapters = {
	documentSymbols: requestDocumentSymbols,
	workspaceSymbols: requestWorkspaceSymbols,
	workspaceSymbolResolve: resolveWorkspaceSymbol,
	references: requestReferences,
};

export type LspFeatureRequest = typeof lspFeatureAdapters;

