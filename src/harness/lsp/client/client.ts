import type { FileChangeType, SymbolInformation, WorkspaceSymbol } from "vscode-languageserver-protocol";

import type { LspDiagnosticInput, LspSavedDiagnostics } from "./diagnostics.ts";
import type { LspDocumentSession } from "./document-session.ts";
import type { LspClientSession } from "./session.ts";
import { LspClientLifecycle } from "./lifecycle.ts";
import { diagnosticSourceKey, DiagnosticsLedger } from "../diagnostics/ledger.ts";
import { requestWorkspaceSymbols, resolveWorkspaceSymbol } from "../protocol/features.ts";
import { pathToFileUri } from "../protocol/uri.ts";
import { diagnosticHints } from "../diagnostics/hints.ts";
import { createOperationDeadline, waitUnlessAborted } from "../analysis/deadline.ts";
import type { LspClientDocumentContext, LspConfig, LspErrorDiagnostic, LspDocumentSymbols, LspRequestOptions, LspRequestResult, LspServerConfig, LspServerStatus } from "../types.ts";

/** 稳定客户端入口，连接代及其业务状态由 lifecycle 统一拥有。 */
export class LspClient {
	private readonly lifecycle: LspClientLifecycle;

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		config: LspConfig,
		private readonly ledger: DiagnosticsLedger,
		onCrash: (message: string) => void,
	) {
		this.lifecycle = new LspClientLifecycle(root, server, config, ledger, onCrash);
	}

	withSession<T>(operation: (session: LspClientSession) => Promise<T>): Promise<T | undefined> {
		return this.lifecycle.withSession(operation);
	}

	diagnosticSource(): string {
		return diagnosticSourceKey(this.root, this.server.id);
	}

	status(): LspServerStatus {
		const lastError = this.lifecycle.lastErrorMessage();
		return {
			id: this.server.id, root: this.root, status: this.lifecycle.status(),
			open_documents: this.lifecycle.session()?.documents.openCount() ?? 0,
			diagnostics: this.ledger.count(this.diagnosticSource(), this.root),
			...(lastError === undefined ? {} : { last_error: lastError }),
		};
	}

	async ensureReady(): Promise<boolean> {
		return await this.lifecycle.ensureReady() !== undefined;
	}

	shutdown(): Promise<void> {
		return this.lifecycle.shutdown();
	}

	async saveAndCollectDiagnosticsBatch<T extends LspDiagnosticInput>(inputs: readonly T[], options: LspRequestOptions): Promise<readonly LspSavedDiagnostics<T>[]> {
		if (inputs.length === 0) return [];
		return await this.withSession((session) => session.diagnostics.collect(inputs, options))
			?? inputs.map((input) => ({ input, result: { kind: "unavailable" as const } }));
	}

	async diagnosticHints(
		filePath: string,
		text: string,
		errors: readonly LspErrorDiagnostic[],
		options: LspRequestOptions & { timeoutMs: number },
	): Promise<readonly (string | undefined)[]> {
		const uri = pathToFileUri(filePath);
		const operation = createOperationDeadline(options.signal, options.timeoutMs);
		try {
			return await this.withSession((session) => waitUnlessAborted(session.documents.enqueue(uri, async () => {
				if (operation.signal.aborted || !session.documents.hasContent(uri, text)) return [];
				const snapshot = this.ledger.snapshot(this.diagnosticSource(), uri);
				return diagnosticHints(session.connection, uri, snapshot.diagnostics, errors, operation.requestOptions());
			}), operation.signal)) ?? [];
		} finally {
			operation.dispose();
		}
	}

	didChangeWatchedFiles(changes: readonly { filePath: string; type: FileChangeType }[]): Promise<boolean> {
		return this.lifecycle.didChangeWatchedFiles(changes);
	}

	async documentSymbols(document: LspClientDocumentContext, options?: LspRequestOptions): Promise<LspRequestResult<LspDocumentSymbols>> {
		return await this.withSession((session) => session.documents.documentSymbols(document, options)) ?? { status: "unavailable" };
	}

	async workspaceSymbols(query: string, options?: LspRequestOptions): Promise<LspRequestResult<Array<SymbolInformation | WorkspaceSymbol>>> {
		return await this.withSession((session) => requestWorkspaceSymbols(session.connection, query, options)) ?? { status: "unavailable" };
	}

	async resolveWorkspaceSymbol(symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<LspRequestResult<WorkspaceSymbol>> {
		return await this.withSession((session) => resolveWorkspaceSymbol(session.connection, symbol, options)) ?? { status: "unavailable" };
	}

	withDocument<T>(document: LspClientDocumentContext, signal: AbortSignal | undefined, operation: (session: LspDocumentSession) => Promise<T>): Promise<T | undefined> {
		return this.withSession((session) => session.documents.withDocument(document, signal, operation));
	}
}
