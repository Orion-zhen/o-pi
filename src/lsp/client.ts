import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CancellationTokenSource,
	createMessageConnection,
	ErrorCodes,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
	type CancellationToken,
	type Disposable,
	type Message,
	type MessageConnection,
	type MessageWriter,
	type NotificationType,
	type RequestType,
} from "vscode-jsonrpc/node";
import {
	DidChangeTextDocumentNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DidSaveTextDocumentNotification,
	ExitNotification,
	InitializedNotification,
	InitializeRequest,
	LogMessageNotification,
	PublishDiagnosticsNotification,
	ShutdownRequest,
	TextDocumentSyncKind,
	type Diagnostic,
	type InitializeResult,
	type Location,
	type LogMessageParams,
	type ServerCapabilities,
	type SymbolInformation,
	type TextDocumentSyncOptions,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import { diagnosticSourceKey, type DiagnosticsLedger } from "./diagnostics.js";
import { incrementalContentChange, languageIdForServerPath, LspDocuments } from "./documents.js";
import { featureAvailable, lspFeatureDefinitions, requestDocumentSymbols, requestReferences, requestWorkspaceSymbols, resolveWorkspaceSymbol, type LspFeatureSession } from "./features/index.js";
import { connectLspTransport, type LspTransportConnection } from "./transport.js";
import type {
	LspClientDocumentContext,
	LspConfig,
	LspDocumentSymbols,
	LspProgressNotification,
	LspRequestOptions,
	LspServerConfig,
	LspServerRequestHandler,
	LspServerStatus,
} from "./types.js";
import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "./uri.js";

/** 单个 language server client，封装 transport、initialize、文档同步、symbol 和诊断通知。 */
export class LspClient implements LspFeatureSession {
	private transport: LspTransportConnection | undefined;
	private connection: MessageConnection | undefined;
	private serverCapabilities: ServerCapabilities | undefined;
	private state: LspServerStatus["status"] = "idle";
	private lastError: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private readonly transportFailureRejectors = new Set<(error: Error) => void>();
	private readonly documents: LspDocuments;
	private readonly diagnosticsSource: string;
	private readonly serverRequestHandlers = new Map<string, LspServerRequestHandler>();
	private readonly serverRequestDisposables = new Map<string, Disposable>();
	private readonly diagnosticListeners = new Set<(params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => void>();
	private readonly logListeners = new Set<(params: LogMessageParams) => void>();
	private readonly progressListeners = new Set<(params: LspProgressNotification) => void>();

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		private readonly config: LspConfig,
		private readonly diagnostics: DiagnosticsLedger,
		private readonly onCrash: (client: LspClient, message: string) => void,
		private readonly getRestartCount: () => number,
	) {
		this.documents = new LspDocuments(config.max_open_documents);
		this.diagnosticsSource = diagnosticSourceKey(root, server.id);
	}

	capabilities(): ServerCapabilities | undefined {
		return this.serverCapabilities;
	}

	diagnosticSource(): string {
		return this.diagnosticsSource;
	}

	onDiagnostics(listener: (params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => void): () => void {
		this.diagnosticListeners.add(listener);
		return () => this.diagnosticListeners.delete(listener);
	}

	onLogMessage(listener: (params: LogMessageParams) => void): () => void {
		this.logListeners.add(listener);
		return () => this.logListeners.delete(listener);
	}

	onProgress(listener: (params: LspProgressNotification) => void): () => void {
		this.progressListeners.add(listener);
		return () => this.progressListeners.delete(listener);
	}

	registerServerRequestHandler(method: string, handler: LspServerRequestHandler): () => void {
		this.serverRequestDisposables.get(method)?.dispose();
		this.serverRequestHandlers.set(method, handler);
		if (this.connection !== undefined) this.installServerRequestHandler(method, handler);
		return () => {
			if (this.serverRequestHandlers.get(method) !== handler) return;
			this.serverRequestDisposables.get(method)?.dispose();
			this.serverRequestDisposables.delete(method);
			this.serverRequestHandlers.delete(method);
		};
	}

	status(): LspServerStatus {
		const status: LspServerStatus = {
			id: this.server.id,
			root: this.root,
			status: this.state,
			restarts: this.getRestartCount(),
			open_documents: this.documents.openCount(),
			diagnostics: this.diagnostics.all().reduce((sum, entry) => {
				if (entry.source !== this.diagnosticsSource) return sum;
				const filePath = fileUriToPath(entry.uri);
				return filePath !== undefined && workspaceRelativePath(this.root, filePath) !== undefined ? sum + entry.items.length : sum;
			}, 0),
		};
		if (this.lastError !== undefined) status.last_error = this.lastError;
		return status;
	}

	async ensureReady(): Promise<boolean> {
		if (this.state === "ready") {
			this.bumpIdleTimer();
			return true;
		}
		if (this.state === "starting") return this.waitUntilReady();
		if (this.state === "unavailable" || this.state === "crashed") return false;
		return this.start();
	}

	async shutdown(): Promise<void> {
		this.clearIdleTimer();
		const connection = this.connection;
		const transport = this.transport;
		this.connection = undefined;
		this.transport = undefined;
		this.state = "stopped";
		this.rejectTransportWaiters("server stopped");
		if (connection !== undefined) {
			for (const uri of this.documents.openUris()) {
				try {
					await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
				} catch {
					// didClose 失败不应阻塞后续 shutdown 和 transport 清理。
				}
			}
			try {
				await withTimeout(connection.sendRequest(ShutdownRequest.type, undefined), 1000);
			} catch {
				// shutdown 是清理路径；server 已退出或 pipe 已关闭时只需继续释放本地资源。
			}
			try {
				await connection.sendNotification(ExitNotification.type);
			} catch {
				// exit notification 失败不影响文件工具主流程或后续重启。
			}
			connection.dispose();
		}
		this.documents.clear();
		this.disposeServerRequestDisposables();
		this.serverCapabilities = undefined;
		if (transport !== undefined) await transport.close();
	}

	async didOpenOrChange(filePath: string, text: string): Promise<boolean> {
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		const document = this.documentContext(filePath, text);
		const synchronized = await this.documents.enqueue(document.uri, async () => {
			const result = await this.synchronizeDocument(connection, document);
			if (result) this.bumpIdleTimer();
			return result;
		});
		await this.trimDocuments(connection, document.uri);
		return synchronized;
	}

	async didSave(filePath: string, text: string): Promise<boolean> {
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		const document = this.documentContext(filePath, text);
		const saved = await this.documents.enqueue(document.uri, async () => {
			const synchronized = await this.synchronizeDocument(connection, document);
			if (!synchronized) return false;
			const policy = textDocumentSyncPolicy(this.serverCapabilities);
			if (!policy.save) return true;
			const sent = await this.sendNotification(connection, (active) => active.sendNotification(DidSaveTextDocumentNotification.type, {
				textDocument: { uri: document.uri },
				...(policy.includeText ? { text: document.text } : {}),
			}));
			if (sent) this.bumpIdleTimer();
			return sent;
		});
		await this.trimDocuments(connection, document.uri);
		return saved;
	}

	async didClose(filePath: string): Promise<boolean> {
		const uri = pathToFileUri(filePath);
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		return this.documents.enqueue(uri, async () => this.closeDocument(connection, uri));
	}

	async notification<P>(type: NotificationType<P>, params: P): Promise<boolean> {
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		const sent = await this.sendNotification(connection, (active) => active.sendNotification(type.method, params));
		if (sent) this.bumpIdleTimer();
		return sent;
	}

	async request<P, R, E>(type: RequestType<P, R, E>, params: P, options: LspRequestOptions = {}): Promise<R | undefined> {
		const connection = await this.readyConnection();
		if (connection === undefined) return undefined;
		const source = new CancellationTokenSource();
		const timeoutMs = options.timeoutMs ?? this.config.request_timeout_ms;
		let timer: NodeJS.Timeout | undefined;
		let rejectCancellation: (error: Error) => void = () => undefined;
		const cancelled = new Promise<never>((_resolve, reject) => {
			rejectCancellation = reject;
		});
		const cancel = (message: string): void => {
			source.cancel();
			rejectCancellation(new Error(message));
		};
		const onAbort = (): void => cancel("request cancelled");
		if (options.signal?.aborted === true) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				source.cancel();
				reject(new Error("timeout"));
			}, timeoutMs);
		});
		try {
			const result = await Promise.race([
				this.withTransportFailure(() => connection.sendRequest(type.method, params, source.token) as Promise<R>),
				timeout,
				cancelled,
			]);
			this.bumpIdleTimer();
			return result;
		} catch (error) {
			this.lastError = errorMessage(error);
			return undefined;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			source.dispose();
		}
	}

	async documentSymbols(filePath: string, text: string): Promise<LspDocumentSymbols | undefined> {
		if (!featureAvailable(this, lspFeatureDefinitions.documentSymbols)) return undefined;
		const connection = await this.readyConnection();
		if (connection === undefined) return undefined;
		const document = this.documentContext(filePath, text);
		const symbols = await this.documents.enqueue(document.uri, async () => {
			if (!await this.synchronizeDocument(connection, document)) return undefined;
			const state = this.documents.state(document.uri);
			if (state === undefined) return undefined;
			const cached = this.documents.cachedSymbols(document.uri, state.version);
			if (cached !== undefined) return cached;
			const requested = await requestDocumentSymbols(this, document.uri);
			if (requested !== undefined) this.documents.cacheSymbols(document.uri, state.version, requested);
			return requested;
		});
		await this.trimDocuments(connection, document.uri);
		return symbols;
	}

	async workspaceSymbols(query: string): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
		return requestWorkspaceSymbols(this, query);
	}

	async resolveWorkspaceSymbol(symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
		return resolveWorkspaceSymbol(this, symbol, options);
	}

	async references(uri: string, line: number, character: number): Promise<Location[] | undefined> {
		return requestReferences(this, uri, line, character);
	}

	private documentContext(filePath: string, text: string): LspClientDocumentContext {
		return this.documents.context(filePath, text, languageIdForServerPath(this.server, filePath));
	}

	private async synchronizeDocument(connection: MessageConnection, document: LspClientDocumentContext): Promise<boolean> {
		const previous = this.documents.state(document.uri);
		if (previous?.text === document.text) {
			this.documents.touch(document.uri);
			return true;
		}

		if (previous === undefined) {
			while (this.documents.needsCapacity(document.uri)) {
				const evicted = await this.evictOneDocument(connection, document.uri);
				if (!evicted) break;
			}
			const policy = textDocumentSyncPolicy(this.serverCapabilities);
			if (policy.openClose) {
				this.documents.setPendingVersion(document.uri, 1);
				let sent: boolean;
				try {
					sent = await this.sendNotification(connection, (active) => active.sendNotification(DidOpenTextDocumentNotification.type, {
						textDocument: {
							uri: document.uri,
							languageId: document.languageId,
							version: 1,
							text: document.text,
						},
					}));
				} finally {
					this.documents.clearPendingVersion(document.uri, 1);
				}
				if (!sent) return false;
			}
			this.documents.commit(document, 1, policy.openClose);
			return true;
		}

		const policy = textDocumentSyncPolicy(this.serverCapabilities);
		const version = previous.version + 1;
		if (policy.change !== TextDocumentSyncKind.None) {
			const contentChanges = policy.change === TextDocumentSyncKind.Incremental
				? [incrementalContentChange(previous.text, document.text)]
				: [{ text: document.text }];
			this.documents.setPendingVersion(document.uri, version);
			let sent: boolean;
			try {
				sent = await this.sendNotification(connection, (active) => active.sendNotification(DidChangeTextDocumentNotification.type, {
					textDocument: { uri: document.uri, version },
					contentChanges,
				}));
			} finally {
				this.documents.clearPendingVersion(document.uri, version);
			}
			if (!sent) return false;
		}
		this.documents.commit(document, version, previous.open);
		return true;
	}

	private async trimDocuments(connection: MessageConnection, excludeUri: string): Promise<void> {
		while (this.documents.overCapacity()) {
			if (!await this.evictOneDocument(connection, excludeUri)) return;
		}
	}

	private async evictOneDocument(connection: MessageConnection, excludeUri: string): Promise<boolean> {
		const uri = this.documents.evictionCandidate(excludeUri);
		if (uri === undefined) return false;
		return this.documents.enqueue(uri, async () => this.closeDocument(connection, uri));
	}

	private async closeDocument(connection: MessageConnection, uri: string): Promise<boolean> {
		const state = this.documents.state(uri);
		if (state === undefined) return true;
		if (state.open) {
			const sent = await this.sendNotification(connection, (active) => active.sendNotification(DidCloseTextDocumentNotification.type, {
				textDocument: { uri },
			}));
			if (!sent) return false;
		}
		this.documents.remove(uri);
		this.bumpIdleTimer();
		return true;
	}

	private async readyConnection(): Promise<MessageConnection | undefined> {
		const ready = await this.ensureReady();
		if (!ready) return undefined;
		return this.connection;
	}

	private async start(): Promise<boolean> {
		this.state = "starting";
		this.lastError = undefined;
		this.serverCapabilities = undefined;
		let transport: LspTransportConnection;
		try {
			transport = await connectLspTransport(this.server.transport, this.root, this.config.startup_timeout_ms);
		} catch (error) {
			this.markUnavailable(errorMessage(error));
			return false;
		}
		this.transport = transport;

		let connection: MessageConnection | undefined;
		const writer = new SafeMessageWriter(new StreamMessageWriter(transport.writer), (error) => {
			if (connection === undefined || this.connection !== connection) return;
			this.markTransportFailure(errorMessage(error));
		});
		connection = createMessageConnection(new StreamMessageReader(transport.reader), writer);
		this.connection = connection;
		void transport.failure.catch((error) => {
			if (this.transport !== transport) return;
			this.markTransportFailure(errorMessage(error));
		});
		connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
			const currentVersion = this.documents.currentVersion(params.uri);
			if (params.version !== undefined && currentVersion !== undefined && params.version < currentVersion) return;
			const diagnostics = params.diagnostics as Diagnostic[];
			this.diagnostics.update(
				this.diagnosticsSource,
				params.uri,
				diagnostics,
				this.config.diagnostics.min_severity,
				params.version,
			);
			this.notifyListeners(this.diagnosticListeners, {
				uri: params.uri,
				diagnostics,
				...(params.version !== undefined ? { version: params.version } : {}),
			});
		});
		connection.onNotification(LogMessageNotification.type, (params) => {
			this.notifyListeners(this.logListeners, params);
		});
		connection.onNotification("$/progress", (params) => {
			if (isProgressNotification(params)) this.notifyListeners(this.progressListeners, params);
		});
		connection.onRequest((method, _params, _token) => {
			throw new ResponseError(ErrorCodes.MethodNotFound, `Unsupported server request: ${method}`);
		});
		for (const [method, handler] of this.serverRequestHandlers) this.installServerRequestHandler(method, handler);
		connection.onError(([error]) => {
			if (this.connection !== connection) return;
			this.markTransportFailure(error.message);
		});
		connection.onClose(() => {
			if (this.connection !== connection) return;
			this.markTransportFailure("connection closed");
		});
		connection.listen();

		try {
			const initializeResult = await withTimeout(
				this.withTransportFailure(() => connection.sendRequest(InitializeRequest.type, {
					processId: process.pid,
					rootUri: pathToFileUri(this.root),
					workspaceFolders: [{ uri: pathToFileUri(this.root), name: path.basename(this.root) || this.root }],
					capabilities: {
						textDocument: {
							synchronization: { didSave: true },
							documentSymbol: { hierarchicalDocumentSymbolSupport: true },
							references: { dynamicRegistration: false },
							publishDiagnostics: { relatedInformation: false },
						},
						workspace: { symbol: { resolveSupport: { properties: ["location.range"] } } },
					},
					initializationOptions: this.server.initialization_options,
				})),
				this.config.startup_timeout_ms,
			) as InitializeResult;
			this.serverCapabilities = initializeResult.capabilities;
			const initialized = await this.sendNotification(connection, (active) => active.sendNotification(InitializedNotification.type, {}));
			if (!initialized) throw new Error("failed to send initialized notification");
			this.state = "ready";
			this.bumpIdleTimer();
			return true;
		} catch (error) {
			this.markUnavailable(errorMessage(error));
			this.connection = undefined;
			this.transport = undefined;
			connection.dispose();
			await transport.close();
			return false;
		}
	}

	private async waitUntilReady(): Promise<boolean> {
		const started = Date.now();
		while (this.state === "starting" && Date.now() - started < this.config.startup_timeout_ms) {
			await delay(25);
		}
		return this.state === "ready";
	}

	private async sendNotification(connection: MessageConnection, factory: (connection: MessageConnection) => Promise<void>): Promise<boolean> {
		if (this.connection !== connection || !this.canUseConnection()) return false;
		try {
			await this.withTransportFailure(() => factory(connection));
			return this.connection === connection && this.canUseConnection();
		} catch (error) {
			this.markTransportFailure(errorMessage(error));
			return false;
		}
	}

	private async withTransportFailure<T>(factory: () => Promise<T>): Promise<T> {
		let rejectTransport: ((error: Error) => void) | undefined;
		const localFailure = new Promise<never>((_resolve, reject) => {
			rejectTransport = reject;
			this.transportFailureRejectors.add(reject);
		});
		const transportFailure = this.transport?.failure;
		try {
			const operation = Promise.resolve().then(factory);
			return transportFailure === undefined
				? await Promise.race([operation, localFailure])
				: await Promise.race([operation, localFailure, transportFailure]);
		} finally {
			if (rejectTransport !== undefined) this.transportFailureRejectors.delete(rejectTransport);
		}
	}

	private installServerRequestHandler(method: string, handler: LspServerRequestHandler): void {
		this.serverRequestDisposables.get(method)?.dispose();
		const connection = this.connection;
		if (connection === undefined) return;
		this.serverRequestDisposables.set(method, connection.onRequest(method, (params, token: CancellationToken) => handler(params, token)));
	}

	private disposeServerRequestDisposables(): void {
		for (const disposable of this.serverRequestDisposables.values()) disposable.dispose();
		this.serverRequestDisposables.clear();
	}

	private notifyListeners<T>(listeners: Set<(value: T) => void>, value: T): void {
		for (const listener of listeners) {
			try {
				listener(value);
			} catch {
				// 外部通知监听器不能破坏 JSON-RPC reader 或 file-tools 主流程。
			}
		}
	}

	private canUseConnection(): boolean {
		return this.state === "starting" || this.state === "ready";
	}

	private markTransportFailure(message: string): void {
		if (this.state === "stopped" || this.state === "unavailable" || this.state === "crashed") return;
		if (this.state === "starting") {
			this.markUnavailable(message);
			return;
		}
		this.markCrashed(message);
		this.onCrash(this, message);
	}

	private markUnavailable(message: string): void {
		if (this.state === "stopped") return;
		this.state = "unavailable";
		this.lastError = message;
		this.clearIdleTimer();
		this.rejectTransportWaiters(message);
	}

	private markCrashed(message: string): void {
		if (this.state === "stopped" || this.state === "unavailable") return;
		this.state = "crashed";
		this.lastError = message;
		this.clearIdleTimer();
		this.rejectTransportWaiters(message);
	}

	private rejectTransportWaiters(message: string): void {
		const error = new Error(message);
		for (const reject of this.transportFailureRejectors) reject(error);
		this.transportFailureRejectors.clear();
	}

	private bumpIdleTimer(): void {
		this.clearIdleTimer();
		if (this.config.idle_timeout_ms <= 0) return;
		this.idleTimer = setTimeout(() => {
			void this.shutdown();
		}, this.config.idle_timeout_ms);
		this.idleTimer.unref();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer === undefined) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
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

class SafeMessageWriter implements MessageWriter {
	constructor(
		private readonly inner: MessageWriter,
		private readonly onWriteError: (error: unknown) => void,
	) {}

	get onError(): MessageWriter["onError"] {
		return this.inner.onError;
	}

	get onClose(): MessageWriter["onClose"] {
		return this.inner.onClose;
	}

	async write(msg: Message): Promise<void> {
		try {
			await this.inner.write(msg);
		} catch (error) {
			this.onWriteError(error);
		}
	}

	end(): void {
		this.inner.end();
	}

	dispose(): void {
		this.inner.dispose();
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function isProgressNotification(value: unknown): value is LspProgressNotification {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (typeof record.token === "string" || typeof record.token === "number") && "value" in record;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
