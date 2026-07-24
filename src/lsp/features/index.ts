import type { RequestType } from "vscode-jsonrpc/node";
import {
	DocumentSymbolRequest,
	ReferencesRequest,
	WorkspaceSymbolRequest,
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
	supportsCapability(capability: keyof LspServerCapabilities): boolean;
	didOpenOrChange(filePath: string, text: string): Promise<boolean>;
	request<P, R, E>(type: RequestType<P, R, E>, params: P, options?: LspRequestOptions): Promise<R | undefined>;
}

export interface LspFeatureDefinition {
	readonly id: "documentSymbols" | "workspaceSymbols" | "references";
	readonly capability: keyof LspServerCapabilities;
}

export const lspFeatureDefinitions = {
	documentSymbols: { id: "documentSymbols", capability: "documentSymbolProvider" },
	workspaceSymbols: { id: "workspaceSymbols", capability: "workspaceSymbolProvider" },
	references: { id: "references", capability: "referencesProvider" },
} as const satisfies Readonly<Record<string, LspFeatureDefinition>>;

export function featureAvailable(session: LspFeatureSession, feature: LspFeatureDefinition): boolean {
	return session.supportsCapability(feature.capability);
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
	references: requestReferences,
};

export type LspFeatureRequest = typeof lspFeatureAdapters;

