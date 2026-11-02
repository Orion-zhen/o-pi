import { PublishDiagnosticsNotification, type Diagnostic } from "vscode-languageserver-protocol";

import { LspClientDiagnostics } from "./diagnostics.ts";
import { LspClientDocuments } from "./documents.ts";
import type { ReadyLspConnection } from "./connection.ts";
import type { DiagnosticsLedger } from "../diagnostics/ledger.ts";
import type { LspConfig, LspServerConfig } from "../types.ts";

/** 已初始化连接独占本代文档和诊断状态。 */
export class LspClientSession {
	readonly documents: LspClientDocuments;
	readonly diagnostics: LspClientDiagnostics;

	constructor(
		root: string,
		server: LspServerConfig,
		config: LspConfig,
		ledger: DiagnosticsLedger,
		readonly connection: ReadyLspConnection,
	) {
		this.documents = new LspClientDocuments(root, server, config, connection);
		this.diagnostics = new LspClientDiagnostics(root, server, config, ledger, this.documents);
		connection.rpc.onNotification(PublishDiagnosticsNotification.type, (params) => this.diagnostics.publish({
			uri: params.uri,
			diagnostics: params.diagnostics as Diagnostic[],
			...(params.version === undefined ? {} : { version: params.version }),
		}, this.documents.currentVersion(params.uri)));
	}

	dispose(): void {
		this.documents.clear();
	}
}
