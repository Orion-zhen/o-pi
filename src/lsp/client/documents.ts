import type { MessageConnection } from "vscode-jsonrpc/node";
import {
	DidChangeTextDocumentNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DidSaveTextDocumentNotification,
	TextDocumentSyncKind,
	type ServerCapabilities,
	type TextDocumentSyncOptions,
} from "vscode-languageserver-protocol";

import { incrementalContentChange, LspDocuments } from "./document-store.js";
import { languageIdForServerPath } from "../config/routing.js";
import type { LspClientTransport } from "./transport.js";
import type {
	LspClientDocumentContext,
	LspConfig,
	LspDocumentSymbols,
	LspRequestOptions,
	LspServerConfig,
} from "../types.js";

/** 管理一个 client 的文档状态、同步队列和容量淘汰。 */
export class LspClientDocuments {
	private readonly documents: LspDocuments;

	constructor(
		private readonly root: string,
		private readonly server: LspServerConfig,
		config: LspConfig,
	) {
		this.documents = new LspDocuments(config.max_open_documents);
	}

	context(filePath: string, text: string): LspClientDocumentContext {
		return this.documents.context(filePath, text, languageIdForServerPath(this.server, this.root, filePath));
	}

	openCount(): number {
		return this.documents.openCount();
	}

	currentVersion(uri: string): number | undefined {
		return this.documents.currentVersion(uri);
	}

	enqueue<T>(uri: string, operation: () => Promise<T>): Promise<T> {
		return this.documents.enqueue(uri, operation);
	}

	async documentSymbols(
		connection: MessageConnection,
		filePath: string,
		text: string,
		options: LspRequestOptions | undefined,
		transport: LspClientTransport,
		requestSymbols: (uri: string, options?: LspRequestOptions) => Promise<LspDocumentSymbols | undefined>,
	): Promise<LspDocumentSymbols | undefined> {
		const document = this.context(filePath, text);
		const symbols = await this.documents.enqueue(document.uri, async () => {
			const previous = this.documents.state(document.uri);
			if (previous?.text === document.text && previous.languageId === document.languageId) {
				const cached = this.documents.cachedSymbols(document.uri, previous.version);
				if (cached !== undefined) return cached;
			}
			if (!await this.synchronizeDocument(connection, document, transport, false)) return undefined;
			const state = this.documents.state(document.uri);
			if (state === undefined) return undefined;
			const requested = await requestSymbols(document.uri, options);
			if (requested !== undefined) this.documents.cacheSymbols(document.uri, state.version, requested);
			return requested;
		});
		await this.closeTransientDocument(connection, document.uri, transport);
		await this.trimDocuments(connection, document.uri, transport);
		return symbols;
	}

	async synchronizeAndSave(
		connection: MessageConnection,
		document: LspClientDocumentContext,
		transport: LspClientTransport,
	): Promise<boolean> {
		if (!await this.synchronizeDocument(connection, document, transport, true)) return false;
		const policy = textDocumentSyncPolicy(transport.capabilities());
		if (!policy.save) return true;
		const sent = await transport.sendNotification(connection, (active) => active.sendNotification(DidSaveTextDocumentNotification.type, {
			textDocument: { uri: document.uri },
			...(policy.includeText ? { text: document.text } : {}),
		}));
		if (sent) transport.bumpIdleTimer();
		return sent;
	}

	async trim(
		connection: MessageConnection,
		excludeUri: string,
		transport: LspClientTransport,
	): Promise<void> {
		await this.trimDocuments(connection, excludeUri, transport);
	}

	clear(): void {
		this.documents.clear();
	}

	private async synchronizeDocument(
		connection: MessageConnection,
		document: LspClientDocumentContext,
		transport: LspClientTransport,
		persistent: boolean,
	): Promise<boolean> {
		const previous = this.documents.state(document.uri);
		const policy = textDocumentSyncPolicy(transport.capabilities());
		if (previous?.text === document.text && previous.languageId === document.languageId && (previous.open || !policy.openClose)) {
			if (persistent) this.documents.markPersistent(document.uri);
			else this.documents.touch(document.uri);
			return true;
		}

		if (previous === undefined || (policy.openClose && !previous.open)) {
			if (previous === undefined) {
				while (this.documents.needsCapacity(document.uri)) {
					const evicted = await this.evictOneDocument(connection, document.uri, transport);
					if (!evicted) break;
				}
			}
			const version = (previous?.version ?? 0) + 1;
			if (policy.openClose) {
				this.documents.setPendingVersion(document.uri, version);
				let sent: boolean;
				try {
					sent = await transport.sendNotification(connection, (active) => active.sendNotification(DidOpenTextDocumentNotification.type, {
						textDocument: {
							uri: document.uri,
							languageId: document.languageId,
							version,
							text: document.text,
						},
					}));
					if (sent) this.documents.commit(document, version, true, persistent);
				} finally {
					this.documents.clearPendingVersion(document.uri, version);
				}
				return sent;
			}
			this.documents.commit(document, version, false, persistent);
			return true;
		}

		const version = previous.version + 1;
		if (policy.change !== TextDocumentSyncKind.None) {
			const contentChanges = policy.change === TextDocumentSyncKind.Incremental
				? [incrementalContentChange(previous.text, document.text)]
				: [{ text: document.text }];
			this.documents.setPendingVersion(document.uri, version);
			let sent: boolean;
			try {
				sent = await transport.sendNotification(connection, (active) => active.sendNotification(DidChangeTextDocumentNotification.type, {
					textDocument: { uri: document.uri, version },
					contentChanges,
				}));
				if (sent) this.documents.commit(document, version, previous.open, persistent);
			} finally {
				this.documents.clearPendingVersion(document.uri, version);
			}
			return sent;
		}
		this.documents.commit(document, version, previous.open, persistent);
		return true;
	}

	private async trimDocuments(
		connection: MessageConnection,
		excludeUri: string,
		transport: LspClientTransport,
	): Promise<void> {
		while (this.documents.overCapacity()) {
			if (!await this.evictOneDocument(connection, excludeUri, transport)) return;
		}
	}

	private async evictOneDocument(
		connection: MessageConnection,
		excludeUri: string,
		transport: LspClientTransport,
	): Promise<boolean> {
		const uri = this.documents.evictionCandidate(excludeUri);
		if (uri === undefined) return false;
		return this.documents.enqueue(uri, async () => this.closeDocument(connection, uri, transport));
	}

	private async closeTransientDocument(
		connection: MessageConnection,
		uri: string,
		transport: LspClientTransport,
	): Promise<boolean> {
		return this.documents.enqueue(uri, async () => {
			const state = this.documents.state(uri);
			if (state === undefined || state.persistent) return true;
			return this.closeDocument(connection, uri, transport, true);
		});
	}

	private async closeDocument(
		connection: MessageConnection,
		uri: string,
		transport: LspClientTransport,
		retainState = false,
	): Promise<boolean> {
		const state = this.documents.state(uri);
		if (state === undefined) return true;
		if (state.open) {
			const sent = await transport.sendNotification(connection, (active) => active.sendNotification(DidCloseTextDocumentNotification.type, {
				textDocument: { uri },
			}));
			if (!sent) return false;
		}
		if (retainState) this.documents.markClosed(uri);
		else this.documents.remove(uri);
		transport.bumpIdleTimer();
		return true;
	}
}

interface TextDocumentSyncPolicy {
	openClose: boolean;
	change: TextDocumentSyncKind;
	save: boolean;
	includeText: boolean;
}

function textDocumentSyncPolicy(capabilities: ServerCapabilities | undefined): TextDocumentSyncPolicy {
	const sync: TextDocumentSyncOptions | TextDocumentSyncKind | undefined = capabilities?.textDocumentSync;
	if (typeof sync === "number") {
		return {
			openClose: sync !== TextDocumentSyncKind.None,
			change: sync,
			save: false,
			includeText: false,
		};
	}
	if (sync === undefined || sync === null) {
		return { openClose: false, change: TextDocumentSyncKind.None, save: false, includeText: false };
	}
	const saveOptions = typeof sync.save === "object" && sync.save !== null ? sync.save : undefined;
	return {
		openClose: sync.openClose === true,
		change: sync.change ?? TextDocumentSyncKind.None,
		save: sync.save === true || saveOptions !== undefined,
		includeText: saveOptions?.includeText === true,
	};
}
