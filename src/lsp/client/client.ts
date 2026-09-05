import {
	PublishDiagnosticsNotification,
	type CallHierarchyIncomingCall,
	type Diagnostic,
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
import type { LspClientConnection } from "./connection.js";
import { diagnosticSourceKey, DiagnosticsLedger } from "../diagnostics/ledger.js";
import {
	requestIncomingCalls,
	requestReferences,
	requestWorkspaceSymbols,
	resolveWorkspaceSymbol,
} from "../protocol/features.js";
import { pathToFileUri } from "../protocol/uri.js";
import type { LspConfig, LspDocumentSymbols, LspRequestOptions, LspServerConfig, LspServerStatus } from "../types.js";

interface ClientSession {
	connection: LspClientConnection;
	documents: LspClientDocuments;
	diagnostics: LspClientDiagnostics;
}

/** 稳定客户端入口，每次连接重建时创建独立的文档与诊断状态。 */
export class LspClient {
	private session: ClientSession | undefined;
	private readonly lifecycle: LspClientLifecycle;

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		config: LspConfig,
		private readonly ledger: DiagnosticsLedger,
		onCrash: (message: string) => void,
	) {
		this.lifecycle = new LspClientLifecycle(root, server, config, {
			onConnection: (connection) => {
				const documents = new LspClientDocuments(root, server, config, connection);
				const diagnostics = new LspClientDiagnostics(root, server, config, ledger, documents);
				connection.rpc.onNotification(PublishDiagnosticsNotification.type, (params) => diagnostics.publish({
					uri: params.uri,
					diagnostics: params.diagnostics as Diagnostic[],
					...(params.version === undefined ? {} : { version: params.version }),
				}, documents.currentVersion(params.uri)));
				this.session = { connection, documents, diagnostics };
			},
			onCleanup: () => {
				this.session?.documents.clear();
				this.session = undefined;
			},
			onCrash,
		});
	}

	capabilities(): ServerCapabilities | undefined {
		return this.session?.connection.capabilities();
	}

	diagnosticSource(): string {
		return diagnosticSourceKey(this.root, this.server.id);
	}

	status(): LspServerStatus {
		const lastError = this.lifecycle.lastErrorMessage();
		return {
			id: this.server.id, root: this.root, status: this.lifecycle.status(),
			open_documents: this.session?.documents.openCount() ?? 0,
			diagnostics: this.ledger.count(this.diagnosticSource(), this.root),
			...(lastError === undefined ? {} : { last_error: lastError }),
		};
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
		return await this.withSession((session) => session.diagnostics.collect(inputs, options))
			?? inputs.map(() => ({ kind: "unavailable" as const }));
	}

	didChangeWatchedFiles(changes: readonly { filePath: string; type: FileChangeType }[]): Promise<boolean> {
		return this.lifecycle.didChangeWatchedFiles(changes);
	}

	documentSymbols(filePath: string, text: string, options?: LspRequestOptions): Promise<LspDocumentSymbols | undefined> {
		return this.withSession((session) => session.documents.documentSymbols(filePath, text, options));
	}

	workspaceSymbols(query: string, options?: LspRequestOptions): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
		return this.withSession((session) => requestWorkspaceSymbols(session.connection, query, options));
	}

	resolveWorkspaceSymbol(symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
		return this.withSession((session) => resolveWorkspaceSymbol(session.connection, symbol, options));
	}

	references(filePath: string, position: Position, options?: LspRequestOptions): Promise<Location[] | undefined> {
		return this.withSession((session) => requestReferences(session.connection, pathToFileUri(filePath), position, options));
	}

	incomingCalls(filePath: string, position: Position, options?: LspRequestOptions): Promise<CallHierarchyIncomingCall[] | undefined> {
		return this.withSession((session) => requestIncomingCalls(session.connection, pathToFileUri(filePath), position, options));
	}

	private withSession<T>(operation: (session: ClientSession) => Promise<T>): Promise<T | undefined> {
		return this.lifecycle.withOperation(async () => {
			if (!await this.ensureReady() || this.session === undefined) return undefined;
			return operation(this.session);
		});
	}
}
