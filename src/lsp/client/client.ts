import type { RequestType } from "vscode-jsonrpc/node";
import {
	type CallHierarchyIncomingCall,
	type FileChangeType,
	type Location,
	type Position,
	type ServerCapabilities,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import { LspClientDiagnostics, type LspSaveDiagnosticsResult } from "./diagnostics.js";
import { LspClientDocuments } from "./documents.js";
import { LspClientLifecycle } from "./lifecycle.js";
import { DiagnosticsLedger } from "../diagnostics/ledger.js";
import {
	requestDocumentSymbols,
	requestIncomingCalls,
	requestReferences,
	requestWorkspaceSymbols,
	resolveWorkspaceSymbol,
	type LspFeatureSession,
} from "../protocol/features.js";
import { LspProtocolInfrastructure } from "../protocol/infrastructure.js";
import { pathToFileUri } from "../protocol/uri.js";
import type {
	LspConfig,
	LspDocumentSymbols,
	LspRequestOptions,
	LspServerConfig,
	LspServerStatus,
} from "../types.js";

/** 单个 language server client 的稳定外观；内部状态由生命周期、文档和 diagnostics 协作者分别负责。 */
export class LspClient implements LspFeatureSession {
	private readonly documents: LspClientDocuments;
	private readonly diagnostics: LspClientDiagnostics;
	private readonly lifecycle: LspClientLifecycle;

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		config: LspConfig,
		diagnostics: DiagnosticsLedger,
		onCrash: (client: LspClient, message: string) => void,
	) {
		this.documents = new LspClientDocuments(root, server, config);
		this.diagnostics = new LspClientDiagnostics(root, server, config, diagnostics, this.documents);
		this.lifecycle = new LspClientLifecycle(
			root,
			server,
			config,
			new LspProtocolInfrastructure(root, server.settings),
			{
				onPublishDiagnostics: (params) => this.diagnostics.publish(params, this.documents.currentVersion(params.uri)),
				onCleanup: () => {
					this.documents.clear();
					this.diagnostics.clear();
				},
				onCrash: (message) => onCrash(this, message),
			},
		);
	}

	capabilities(): ServerCapabilities | undefined {
		return this.lifecycle.capabilities();
	}

	diagnosticSource(): string {
		return this.diagnostics.diagnosticSource();
	}

	status(): LspServerStatus {
		const status: LspServerStatus = {
			id: this.server.id,
			root: this.root,
			status: this.lifecycle.status(),
			open_documents: this.documents.openCount(),
			diagnostics: this.diagnostics.count(),
		};
		const lastError = this.lifecycle.lastErrorMessage();
		if (lastError !== undefined) status.last_error = lastError;
		return status;
	}

	ensureReady(): Promise<boolean> {
		return this.lifecycle.ensureReady();
	}

	shutdown(): Promise<void> {
		return this.lifecycle.shutdown();
	}

	async saveAndCollectDiagnosticsBatch(
		inputs: readonly { filePath: string; text: string }[],
		options: LspRequestOptions,
	): Promise<readonly LspSaveDiagnosticsResult[]> {
		if (inputs.length === 0) return [];
		return this.lifecycle.withOperation(async () => {
			const connection = await this.lifecycle.readyConnection();
			if (connection === undefined) return inputs.map(() => ({ kind: "unavailable" as const }));
			return this.diagnostics.collect(connection, inputs, options, this.lifecycle);
		});
	}

	didChangeWatchedFiles(changes: readonly { filePath: string; type: FileChangeType }[]): Promise<boolean> {
		return this.lifecycle.didChangeWatchedFiles(changes);
	}

	request<P, R, E>(type: RequestType<P, R, E>, params: P, options: LspRequestOptions = {}): Promise<R | undefined> {
		return this.lifecycle.request(type, params, options);
	}

	async documentSymbols(filePath: string, text: string, options?: LspRequestOptions): Promise<LspDocumentSymbols | undefined> {
		return this.lifecycle.withOperation(async () => {
			const connection = await this.lifecycle.readyConnection();
			if (connection === undefined) return undefined;
			return this.documents.documentSymbols(
				connection,
				filePath,
				text,
				options,
				this.lifecycle,
				(uri, requestOptions) => requestDocumentSymbols(this, uri, requestOptions),
			);
		});
	}

	workspaceSymbols(query: string, options?: LspRequestOptions): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
		return requestWorkspaceSymbols(this, query, options);
	}

	resolveWorkspaceSymbol(symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
		return resolveWorkspaceSymbol(this, symbol, options);
	}

	references(filePath: string, position: Position, options?: LspRequestOptions): Promise<Location[] | undefined> {
		return requestReferences(this, pathToFileUri(filePath), position, options);
	}

	incomingCalls(filePath: string, position: Position, options?: LspRequestOptions): Promise<CallHierarchyIncomingCall[] | undefined> {
		return requestIncomingCalls(this, pathToFileUri(filePath), position, options);
	}
}
