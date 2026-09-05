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

import { incrementalContentChange } from "./text-change.js";
import { languageIdForServerPath } from "../config/routing.js";
import { requestDocumentSymbols } from "../protocol/features.js";
import { pathToFileUri } from "../protocol/uri.js";
import type { LspClientConnection } from "./connection.js";
import type { LspClientDocumentContext, LspConfig, LspDocumentSymbols, LspRequestOptions, LspServerConfig } from "../types.js";

interface DocumentState extends LspClientDocumentContext {
	version: number;
	open: boolean;
	persistent: boolean;
	lastUsed: number;
	cachedSymbols?: LspDocumentSymbols;
}

/** 一代连接的文档同步、同 URI 队列和有界符号缓存。 */
export class LspClientDocuments {
	private readonly states = new Map<string, DocumentState>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly pendingVersions = new Map<string, number>();
	private clock = 0;
	private readonly maxDocuments: number;

	constructor(
		private readonly root: string,
		private readonly server: LspServerConfig,
		config: LspConfig,
		readonly connection: LspClientConnection,
	) {
		this.maxDocuments = config.max_open_documents;
	}

	context(filePath: string, text: string): LspClientDocumentContext {
		return {
			uri: pathToFileUri(filePath), path: filePath, text,
			languageId: languageIdForServerPath(this.server, this.root, filePath),
		};
	}

	openCount(): number {
		let count = 0;
		for (const state of this.states.values()) if (state.open) count += 1;
		return count;
	}

	currentVersion(uri: string): number | undefined {
		return this.pendingVersions.get(uri) ?? this.states.get(uri)?.version;
	}

	async enqueue<T>(uri: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(uri) ?? Promise.resolve();
		const run = previous.then(operation);
		const tail = run.then(() => undefined, () => undefined);
		this.queues.set(uri, tail);
		try {
			return await run;
		} finally {
			if (this.queues.get(uri) === tail) this.queues.delete(uri);
		}
	}

	async documentSymbols(filePath: string, text: string, options?: LspRequestOptions): Promise<LspDocumentSymbols | undefined> {
		const document = this.context(filePath, text);
		const symbols = await this.enqueue(document.uri, async () => {
			const previous = this.states.get(document.uri);
			if (previous?.text === document.text && previous.languageId === document.languageId && previous.cachedSymbols !== undefined) {
				previous.lastUsed = ++this.clock;
				return previous.cachedSymbols;
			}
			if (!await this.synchronizeDocument(document, false)) return undefined;
			const state = this.states.get(document.uri);
			if (state === undefined) return undefined;
			const requested = await requestDocumentSymbols(this.connection, document.uri, options);
			if (requested !== undefined && this.states.get(document.uri) === state) {
				state.cachedSymbols = requested;
				state.lastUsed = ++this.clock;
			}
			return requested;
		});
		await this.enqueue(document.uri, async () => {
			const state = this.states.get(document.uri);
			if (state !== undefined && !state.persistent) await this.closeDocument(document.uri, true);
		});
		await this.trim(document.uri);
		return symbols;
	}

	async synchronizeAndSave(document: LspClientDocumentContext): Promise<boolean> {
		if (!await this.synchronizeDocument(document, true)) return false;
		const policy = textDocumentSyncPolicy(this.connection.capabilities());
		if (!policy.save) return true;
		return this.connection.notify((rpc) => rpc.sendNotification(DidSaveTextDocumentNotification.type, {
			textDocument: { uri: document.uri },
			...(policy.includeText ? { text: document.text } : {}),
		}));
	}

	async trim(excludeUri: string): Promise<void> {
		while (this.states.size > this.maxDocuments) {
			if (!await this.evictOneDocument(excludeUri)) return;
		}
	}

	clear(): void {
		this.states.clear();
		this.queues.clear();
		this.pendingVersions.clear();
	}

	private async synchronizeDocument(document: LspClientDocumentContext, persistent: boolean): Promise<boolean> {
		const previous = this.states.get(document.uri);
		const policy = textDocumentSyncPolicy(this.connection.capabilities());
		if (previous?.text === document.text && previous.languageId === document.languageId && (previous.open || !policy.openClose)) {
			previous.persistent ||= persistent;
			previous.lastUsed = ++this.clock;
			return true;
		}

		const version = (previous?.version ?? 0) + 1;
		if (previous === undefined || (policy.openClose && !previous.open)) {
			if (previous === undefined) {
				while (this.states.size >= this.maxDocuments) {
					if (!await this.evictOneDocument(document.uri)) break;
				}
			}
			if (policy.openClose) {
				return this.publishState(document, version, true, persistent, (rpc) => rpc.sendNotification(DidOpenTextDocumentNotification.type, {
					textDocument: { uri: document.uri, languageId: document.languageId, version, text: document.text },
				}));
			}
			this.commit(document, version, false, persistent);
			return true;
		}

		if (policy.change !== TextDocumentSyncKind.None) {
			const contentChanges = policy.change === TextDocumentSyncKind.Incremental
				? [incrementalContentChange(previous.text, document.text)]
				: [{ text: document.text }];
			return this.publishState(document, version, previous.open, persistent, (rpc) => rpc.sendNotification(DidChangeTextDocumentNotification.type, {
				textDocument: { uri: document.uri, version }, contentChanges,
			}));
		}
		this.commit(document, version, previous.open, persistent);
		return true;
	}

	/** 待发送版本先参与诊断过滤，通知成功后再提交正文。 */
	private async publishState(
		document: LspClientDocumentContext,
		version: number,
		open: boolean,
		persistent: boolean,
		notify: (rpc: MessageConnection) => Promise<void>,
	): Promise<boolean> {
		this.pendingVersions.set(document.uri, version);
		try {
			const sent = await this.connection.notify(notify);
			if (sent) this.commit(document, version, open, persistent);
			return sent;
		} finally {
			this.pendingVersions.delete(document.uri);
		}
	}

	private commit(document: LspClientDocumentContext, version: number, open: boolean, persistent: boolean): void {
		const previous = this.states.get(document.uri);
		const sameContent = previous?.text === document.text && previous.languageId === document.languageId;
		this.states.set(document.uri, {
			...document, version, open,
			persistent: persistent || previous?.persistent === true,
			lastUsed: ++this.clock,
			...(sameContent && previous.cachedSymbols !== undefined ? { cachedSymbols: previous.cachedSymbols } : {}),
		});
	}

	private async evictOneDocument(excludeUri: string): Promise<boolean> {
		let candidate: DocumentState | undefined;
		for (const state of this.states.values()) {
			if (state.uri === excludeUri || this.queues.has(state.uri)) continue;
			if (candidate === undefined || state.lastUsed < candidate.lastUsed) candidate = state;
		}
		if (candidate === undefined) return false;
		const uri = candidate.uri;
		return this.enqueue(uri, () => this.closeDocument(uri));
	}

	private async closeDocument(uri: string, retainState = false): Promise<boolean> {
		const state = this.states.get(uri);
		if (state === undefined) return true;
		if (state.open) {
			const sent = await this.connection.notify((rpc) => rpc.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } }));
			if (!sent) return false;
		}
		if (retainState) {
			state.open = false;
			state.persistent = false;
			state.lastUsed = ++this.clock;
		} else this.states.delete(uri);
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
		return { openClose: sync !== TextDocumentSyncKind.None, change: sync, save: false, includeText: false };
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
