import path from "node:path";
import pLimit from "p-limit";
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
	ConfigurationRequest,
	DidChangeConfigurationNotification,
	DidChangeTextDocumentNotification,
	DidChangeWatchedFilesNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DidSaveTextDocumentNotification,
	DocumentDiagnosticRequest,
	ExitNotification,
	InitializedNotification,
	InitializeRequest,
	LogMessageNotification,
	PublishDiagnosticsNotification,
	RegistrationRequest,
	ShutdownRequest,
	TextDocumentSyncKind,
	WorkDoneProgressCreateRequest,
	WorkspaceFoldersRequest,
	type Diagnostic,
	type DocumentDiagnosticReport,
	type FileChangeType,
	type FullDocumentDiagnosticReport,
	type InitializeResult,
	type Location,
	type LogMessageParams,
	type ServerCapabilities,
	type SymbolInformation,
	type TextDocumentSyncOptions,
	type UnchangedDocumentDiagnosticReport,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import { diagnosticSourceKey, type DiagnosticsLedger } from "./diagnostics.js";
import { incrementalContentChange, LspDocuments } from "./documents.js";
import {
	featureAvailable,
	lspFeatureDefinitions,
	requestDocumentSymbols,
	requestReferences,
	requestTypeScriptDiagnostics,
	requestWorkspaceSymbols,
	resolveWorkspaceSymbol,
	type LspFeatureSession,
} from "./features/index.js";
import { LspProtocolInfrastructure, LspProtocolValidationError } from "./protocol-infrastructure.js";
import { languageIdForServerPath } from "./routing.js";
import { connectLspTransport, type LspTransportConnection } from "./transport.js";
import type {
	LspClientDocumentContext,
	LspConfig,
	LspDiagnosticSnapshot,
	LspDocumentSymbols,
	LspProgressNotification,
	LspRequestOptions,
	LspServerConfig,
	LspServerRequestHandler,
	LspServerStatus,
} from "./types.js";
import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "./uri.js";

const LAST_ERROR_MAX_CHARS = 1024;
const DIAGNOSTIC_REQUEST_CONCURRENCY = 4;
const PROTOCOL_SERVER_REQUEST_METHODS = new Set<string>([
	ConfigurationRequest.method,
	WorkspaceFoldersRequest.method,
	WorkDoneProgressCreateRequest.method,
	RegistrationRequest.method,
]);

type LspSaveDiagnosticsResult =
	| { kind: "unavailable" }
	| { kind: "publish"; waitMs: number }
	| { kind: "pull"; snapshot?: LspDiagnosticSnapshot };

/** 单个 language server client，封装 transport、initialize、文档同步、symbol 和诊断通知。 */
export class LspClient implements LspFeatureSession {
	private transport: LspTransportConnection | undefined;
	private connection: MessageConnection | undefined;
	private serverCapabilities: ServerCapabilities | undefined;
	private state: LspServerStatus["status"] = "idle";
	private lastError: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private startPromise: Promise<boolean> | undefined;
	private stopPromise: Promise<void> | undefined;
	private cleanupPromise: Promise<void> | undefined;
	private inFlightOperations = 0;
	private readonly transportFailureRejectors = new Set<(error: Error) => void>();
	private readonly documents: LspDocuments;
	private readonly diagnosticsSource: string;
	private readonly protocol: LspProtocolInfrastructure;
	private readonly diagnosticResultIds = new Map<string, string>();
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
		this.protocol = new LspProtocolInfrastructure(root, server.settings);
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
		if (PROTOCOL_SERVER_REQUEST_METHODS.has(method)) throw new Error(`Cannot replace built-in server request handler: ${method}`);
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
		if (this.lastError !== undefined) status.last_error = compactError(this.lastError);
		return status;
	}

	async ensureReady(): Promise<boolean> {
		if (this.stopPromise !== undefined) await this.stopPromise;
		if (this.state === "ready") {
			this.bumpIdleTimer();
			return true;
		}
		if (this.state === "unavailable" || this.state === "crashed") return false;
		if (this.startPromise !== undefined) return this.startPromise;
		const pending = this.start();
		this.startPromise = pending;
		try {
			return await pending;
		} finally {
			if (this.startPromise === pending) this.startPromise = undefined;
		}
	}

	async shutdown(): Promise<void> {
		if (this.stopPromise !== undefined) return this.stopPromise;
		const pending = this.performShutdown();
		this.stopPromise = pending;
		try {
			await pending;
		} finally {
			if (this.stopPromise === pending) this.stopPromise = undefined;
		}
	}

	async waitForCleanup(): Promise<void> {
		await this.cleanupPromise;
	}

	async didOpenOrChange(filePath: string, text: string): Promise<boolean> {
		return this.withOperation(async () => {
			const connection = await this.readyConnection();
			if (connection === undefined) return false;
			const document = this.documentContext(filePath, text);
			const synchronized = await this.documents.enqueue(document.uri, async () => {
				const result = await this.synchronizeDocument(connection, document, true);
				if (result) this.bumpIdleTimer();
				return result;
			});
			await this.trimDocuments(connection, document.uri);
			return synchronized;
		});
	}

	async didSave(filePath: string, text: string): Promise<boolean> {
		return this.withOperation(async () => {
			const connection = await this.readyConnection();
			if (connection === undefined) return false;
			const document = this.documentContext(filePath, text);
			const saved = await this.documents.enqueue(document.uri, async () => this.synchronizeAndSave(connection, document));
			await this.trimDocuments(connection, document.uri);
			return saved;
		});
	}

	async saveAndCollectDiagnosticsBatch(
		inputs: readonly { filePath: string; text: string }[],
		options: LspRequestOptions,
	): Promise<readonly LspSaveDiagnosticsResult[]> {
		if (inputs.length === 0) return [];
		return this.withOperation(async () => {
			const connection = await this.readyConnection();
			if (connection === undefined) return inputs.map(() => ({ kind: "unavailable" }));

			const buckets = new Map<string, { document: LspClientDocumentContext; indices: number[] }>();
			for (let index = 0; index < inputs.length; index += 1) {
				const input = inputs[index];
				if (input === undefined) continue;
				const document = this.documentContext(input.filePath, input.text);
				const bucket = buckets.get(document.uri);
				if (bucket === undefined) buckets.set(document.uri, { document, indices: [index] });
				else {
					bucket.document = document;
					bucket.indices.push(index);
				}
			}

			const unique = Array.from(buckets.values());
			let remainingSyncs = unique.length;
			let releaseSynchronized: () => void = () => undefined;
			const synchronized = new Promise<void>((resolve) => {
				releaseSynchronized = resolve;
			});
			let diagnosticDeadline = Number.POSITIVE_INFINITY;
			const diagnosticLimit = pLimit(DIAGNOSTIC_REQUEST_CONCURRENCY);
			const provider = this.serverCapabilities?.diagnosticProvider;
			const supportsPull = typeof provider === "object" && provider !== null;
			const supportsTypeScriptDiagnostics = featureAvailable(this, lspFeatureDefinitions.typescriptDiagnostics);
			const timeoutMs = options.timeoutMs ?? this.config.request_timeout_ms;

			const collected = await Promise.all(unique.map(({ document }) => this.documents.enqueue(
				document.uri,
				async (): Promise<LspSaveDiagnosticsResult> => {
					let saved = false;
					try {
						saved = await this.synchronizeAndSave(connection, document);
					} finally {
						remainingSyncs -= 1;
						if (remainingSyncs === 0) {
							diagnosticDeadline = Date.now() + timeoutMs;
							releaseSynchronized();
						}
					}
					await synchronized;
					if (!saved) return { kind: "unavailable" };
					const remainingMs = (): number => Math.max(0, diagnosticDeadline - Date.now());
					if (!supportsPull) {
						if (!supportsTypeScriptDiagnostics) return { kind: "publish", waitMs: remainingMs() };
						return diagnosticLimit(async () => {
							const availableMs = remainingMs();
							if (availableMs <= 0 || options.signal?.aborted === true) return { kind: "publish", waitMs: 0 };
							const diagnostics = await requestTypeScriptDiagnostics(this, document.uri, {
								...options,
								timeoutMs: availableMs,
							});
							if (diagnostics === undefined) return { kind: "publish", waitMs: remainingMs() };
							const snapshot = this.diagnostics.update(
								this.diagnosticsSource,
								document.uri,
								diagnostics,
								this.config.diagnostics.min_severity,
								this.documents.currentVersion(document.uri),
								this.config.diagnostics.max_related_locations,
							);
							return { kind: "pull", snapshot };
						});
					}
					return diagnosticLimit(async () => {
						const availableMs = remainingMs();
						if (availableMs <= 0 || options.signal?.aborted === true) return { kind: "pull" };
						const previousResultId = this.diagnosticResultIds.get(document.uri);
						const report = await this.requestOnConnection(connection, DocumentDiagnosticRequest.type, {
							textDocument: { uri: document.uri },
							...(provider.identifier === undefined ? {} : { identifier: provider.identifier }),
							...(previousResultId === undefined ? {} : { previousResultId }),
						}, { ...options, timeoutMs: availableMs });
						if (report === undefined) return { kind: "pull" };
						const snapshot = this.applyDocumentDiagnosticReport(document.uri, report);
						return snapshot === undefined ? { kind: "pull" } : { kind: "pull", snapshot };
					});
				},
			)));

			for (const { document } of unique) await this.trimDocuments(connection, document.uri);
			const results: LspSaveDiagnosticsResult[] = inputs.map(() => ({ kind: "unavailable" }));
			for (let bucketIndex = 0; bucketIndex < unique.length; bucketIndex += 1) {
				const result = collected[bucketIndex] ?? { kind: "unavailable" };
				for (const inputIndex of unique[bucketIndex]?.indices ?? []) results[inputIndex] = result;
			}
			return results;
		});
	}

	async didChangeWatchedFile(filePath: string, type: FileChangeType): Promise<boolean> {
		return this.didChangeWatchedFiles([{ filePath, type }]);
	}

	async didChangeWatchedFiles(changes: readonly { filePath: string; type: FileChangeType }[]): Promise<boolean> {
		if (this.state !== "ready") return false;
		const events = changes.flatMap((change) => {
			const event = this.protocol.watchedFileEvent(change.filePath, change.type);
			return event === undefined ? [] : [event];
		});
		if (events.length === 0) return false;
		return this.withOperation(async () => {
			const connection = this.connection;
			if (connection === undefined || this.state !== "ready") return false;
			return this.sendNotification(connection, (active) => active.sendNotification(
				DidChangeWatchedFilesNotification.type,
				{ changes: events },
			));
		});
	}

	async didClose(filePath: string): Promise<boolean> {
		return this.withOperation(async () => {
			const uri = pathToFileUri(filePath);
			const connection = await this.readyConnection();
			if (connection === undefined) return false;
			return this.documents.enqueue(uri, async () => this.closeDocument(connection, uri));
		});
	}

	async notification<P>(type: NotificationType<P>, params: P): Promise<boolean> {
		return this.withOperation(async () => {
			const connection = await this.readyConnection();
			if (connection === undefined) return false;
			const sent = await this.sendNotification(connection, (active) => active.sendNotification(type.method, params));
			if (sent) this.bumpIdleTimer();
			return sent;
		});
	}

	async request<P, R, E>(type: RequestType<P, R, E>, params: P, options: LspRequestOptions = {}): Promise<R | undefined> {
		return this.withOperation(async () => {
			const connection = await this.readyConnection();
			return connection === undefined ? undefined : this.requestOnConnection(connection, type, params, options);
		});
	}

	async documentSymbols(filePath: string, text: string): Promise<LspDocumentSymbols | undefined> {
		return this.withOperation(async () => {
			const connection = await this.readyConnection();
			if (connection === undefined) return undefined;
			const document = this.documentContext(filePath, text);
			const symbols = await this.documents.enqueue(document.uri, async () => {
				const previous = this.documents.state(document.uri);
				if (previous?.text === document.text && previous.languageId === document.languageId) {
					const cached = this.documents.cachedSymbols(document.uri, previous.version);
					if (cached !== undefined) return cached;
				}
				if (!await this.synchronizeDocument(connection, document, false)) return undefined;
				const state = this.documents.state(document.uri);
				if (state === undefined) return undefined;
				const requested = await requestDocumentSymbols(this, document.uri);
				if (requested !== undefined) this.documents.cacheSymbols(document.uri, state.version, requested);
				return requested;
			});
			await this.closeTransientDocument(connection, document.uri);
			await this.trimDocuments(connection, document.uri);
			return symbols;
		});
	}

	async workspaceSymbols(query: string, options?: LspRequestOptions): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
		return requestWorkspaceSymbols(this, query, options);
	}

	async resolveWorkspaceSymbol(symbol: WorkspaceSymbol, options?: LspRequestOptions): Promise<WorkspaceSymbol | undefined> {
		return resolveWorkspaceSymbol(this, symbol, options);
	}

	async references(uri: string, line: number, character: number, options?: LspRequestOptions): Promise<Location[] | undefined> {
		return requestReferences(this, uri, line, character, options);
	}

	private documentContext(filePath: string, text: string): LspClientDocumentContext {
		return this.documents.context(filePath, text, languageIdForServerPath(this.server, this.root, filePath));
	}

	private async synchronizeAndSave(connection: MessageConnection, document: LspClientDocumentContext): Promise<boolean> {
		if (!await this.synchronizeDocument(connection, document, true)) return false;
		const policy = textDocumentSyncPolicy(this.serverCapabilities);
		if (!policy.save) return true;
		const sent = await this.sendNotification(connection, (active) => active.sendNotification(DidSaveTextDocumentNotification.type, {
			textDocument: { uri: document.uri },
			...(policy.includeText ? { text: document.text } : {}),
		}));
		if (sent) this.bumpIdleTimer();
		return sent;
	}

	private async requestOnConnection<P, R, E>(
		connection: MessageConnection,
		type: RequestType<P, R, E>,
		params: P,
		options: LspRequestOptions,
	): Promise<R | undefined> {
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

	private applyDocumentDiagnosticReport(uri: string, report: DocumentDiagnosticReport): LspDiagnosticSnapshot | undefined {
		for (const [relatedUri, relatedReport] of Object.entries(report.relatedDocuments ?? {})) {
			this.applyDiagnosticReport(relatedUri, relatedReport);
		}
		return this.applyDiagnosticReport(uri, report);
	}

	private applyDiagnosticReport(
		uri: string,
		report: FullDocumentDiagnosticReport | UnchangedDocumentDiagnosticReport,
	): LspDiagnosticSnapshot | undefined {
		if (report.kind === "unchanged") {
			const snapshot = this.diagnostics.snapshot(this.diagnosticsSource, uri);
			if (!snapshot.known) return undefined;
			this.diagnosticResultIds.set(uri, report.resultId);
			return snapshot;
		}
		if (report.resultId === undefined) this.diagnosticResultIds.delete(uri);
		else this.diagnosticResultIds.set(uri, report.resultId);
		return this.diagnostics.update(
			this.diagnosticsSource,
			uri,
			report.items,
			this.config.diagnostics.min_severity,
			this.documents.currentVersion(uri),
			this.config.diagnostics.max_related_locations,
		);
	}

	private async synchronizeDocument(
		connection: MessageConnection,
		document: LspClientDocumentContext,
		persistent: boolean,
	): Promise<boolean> {
		const previous = this.documents.state(document.uri);
		const policy = textDocumentSyncPolicy(this.serverCapabilities);
		if (previous?.text === document.text && previous.languageId === document.languageId && (previous.open || !policy.openClose)) {
			if (persistent) this.documents.markPersistent(document.uri);
			else this.documents.touch(document.uri);
			return true;
		}

		if (previous === undefined || (policy.openClose && !previous.open)) {
			if (previous === undefined) {
				while (this.documents.needsCapacity(document.uri)) {
					const evicted = await this.evictOneDocument(connection, document.uri);
					if (!evicted) break;
				}
			}
			const version = (previous?.version ?? 0) + 1;
			if (policy.openClose) {
				this.documents.setPendingVersion(document.uri, version);
				let sent: boolean;
				try {
					sent = await this.sendNotification(connection, (active) => active.sendNotification(DidOpenTextDocumentNotification.type, {
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
				sent = await this.sendNotification(connection, (active) => active.sendNotification(DidChangeTextDocumentNotification.type, {
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

	private async closeTransientDocument(connection: MessageConnection, uri: string): Promise<boolean> {
		return this.documents.enqueue(uri, async () => {
			const state = this.documents.state(uri);
			if (state === undefined || state.persistent) return true;
			return this.closeDocument(connection, uri, true);
		});
	}

	private async closeDocument(connection: MessageConnection, uri: string, retainState = false): Promise<boolean> {
		const state = this.documents.state(uri);
		if (state === undefined) return true;
		if (state.open) {
			const sent = await this.sendNotification(connection, (active) => active.sendNotification(DidCloseTextDocumentNotification.type, {
				textDocument: { uri },
			}));
			if (!sent) return false;
		}
		if (retainState) this.documents.markClosed(uri);
		else this.documents.remove(uri);
		this.bumpIdleTimer();
		return true;
	}

	private async readyConnection(): Promise<MessageConnection | undefined> {
		const ready = await this.ensureReady();
		if (!ready) return undefined;
		return this.connection;
	}

	private async performShutdown(): Promise<void> {
		this.clearIdleTimer();
		this.state = "stopped";
		this.rejectTransportWaiters("server stopped");
		await this.startPromise;
		await this.cleanupPromise;

		const connection = this.connection;
		const transport = this.transport;
		const openUris = this.documents.openUris();
		this.connection = undefined;
		this.transport = undefined;
		this.serverCapabilities = undefined;
		this.disposeServerRequestDisposables();

		if (connection !== undefined) {
			const stepTimeout = Math.min(1000, this.config.request_timeout_ms);
			try {
				await withTimeout(Promise.all(openUris.map((uri) => connection.sendNotification(
					DidCloseTextDocumentNotification.type,
					{ textDocument: { uri } },
				))), stepTimeout);
			} catch {
				// didClose 失败或超时后仍继续强制释放 session。
			}
			try {
				await withTimeout(connection.sendRequest(ShutdownRequest.type, undefined), stepTimeout);
			} catch {
				// shutdown 是有界清理步骤；server 不响应时继续 exit。
			}
			try {
				await withTimeout(connection.sendNotification(ExitNotification.type), stepTimeout);
			} catch {
				// exit 失败不阻止底层 transport 强制关闭。
			}
			connection.dispose();
		}
		try {
			if (transport !== undefined) await transport.close();
		} finally {
			this.documents.clear();
			this.diagnosticResultIds.clear();
			this.protocol.reset();
		}
	}

	private async start(): Promise<boolean> {
		this.state = "starting";
		this.lastError = undefined;
		this.serverCapabilities = undefined;
		let transport: LspTransportConnection;
		try {
			transport = await connectLspTransport(this.server.transport, this.root, this.config.startup_timeout_ms);
		} catch (error) {
			await this.markTransportFailure(errorMessage(error));
			return false;
		}
		if (this.state !== "starting") {
			await transport.close();
			return false;
		}
		this.transport = transport;

		let connection: MessageConnection | undefined;
		const writer = new SafeMessageWriter(new StreamMessageWriter(transport.writer), (error) => {
			if (connection === undefined || this.connection !== connection) return;
			void this.markTransportFailure(errorMessage(error));
		});
		connection = createMessageConnection(new StreamMessageReader(transport.reader), writer);
		this.connection = connection;
		void transport.failure.catch((error) => {
			if (this.transport !== transport) return;
			void this.markTransportFailure(errorMessage(error));
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
				this.config.diagnostics.max_related_locations,
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
		this.installProtocolServerRequestHandlers(connection);
		for (const [method, handler] of this.serverRequestHandlers) this.installServerRequestHandler(method, handler);
		connection.onError(([error]) => {
			if (this.connection !== connection) return;
			void this.markTransportFailure(error.message);
		});
		connection.onClose(() => {
			if (this.connection !== connection) return;
			void this.markTransportFailure("connection closed");
		});
		connection.listen();

		try {
			const initializeResult = await withTimeout(
				this.withTransportFailure(() => connection.sendRequest(InitializeRequest.type, {
					processId: this.server.transport.type === "tcp" ? null : process.pid,
					rootUri: pathToFileUri(this.root),
					workspaceFolders: [{ uri: pathToFileUri(this.root), name: path.basename(this.root) || this.root }],
					capabilities: {
						textDocument: {
							synchronization: { didSave: true },
							documentSymbol: { hierarchicalDocumentSymbolSupport: true },
							references: { dynamicRegistration: false },
							diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
							publishDiagnostics: { relatedInformation: true },
						},
						workspace: {
							configuration: true,
							workspaceFolders: true,
							didChangeConfiguration: { dynamicRegistration: true },
							didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
							symbol: { resolveSupport: { properties: ["location.range"] } },
						},
						window: { workDoneProgress: true },
					},
					initializationOptions: this.server.initializationOptions,
				})),
				this.config.startup_timeout_ms,
			) as InitializeResult;
			if (this.connection !== connection || this.state !== "starting") return false;
			this.serverCapabilities = initializeResult.capabilities;
			const initialized = await this.sendNotification(connection, (active) => active.sendNotification(InitializedNotification.type, {}));
			if (!initialized) throw new Error("failed to send initialized notification");
			const settings = this.protocol.configurationSettings();
			if (settings !== undefined) {
				const configured = await this.sendNotification(connection, (active) => active.sendNotification(
					DidChangeConfigurationNotification.type,
					{ settings },
				));
				if (!configured) throw new Error("failed to send workspace configuration");
			}
			this.state = "ready";
			this.bumpIdleTimer();
			return true;
		} catch (error) {
			await this.markTransportFailure(errorMessage(error));
			return false;
		}
	}

	private async sendNotification(connection: MessageConnection, factory: (connection: MessageConnection) => Promise<void>): Promise<boolean> {
		if (this.connection !== connection || !this.canUseConnection()) return false;
		try {
			await withTimeout(this.withTransportFailure(() => factory(connection)), this.config.request_timeout_ms);
			return this.connection === connection && this.canUseConnection();
		} catch (error) {
			await this.markTransportFailure(errorMessage(error));
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

	private installProtocolServerRequestHandlers(connection: MessageConnection): void {
		this.serverRequestDisposables.set(ConfigurationRequest.method, connection.onRequest(ConfigurationRequest.type, (params) => (
			validatedProtocolResult(() => this.protocol.configuration(params))
		)));
		this.serverRequestDisposables.set(WorkspaceFoldersRequest.method, connection.onRequest(WorkspaceFoldersRequest.type, () => (
			this.protocol.workspaceFolders()
		)));
		this.serverRequestDisposables.set(WorkDoneProgressCreateRequest.method, connection.onRequest(WorkDoneProgressCreateRequest.type, (params) => {
			validatedProtocolResult(() => {
				if (!isWorkDoneProgressCreateParams(params)) throw new LspProtocolValidationError("work-done progress token is invalid");
			});
		}));
		this.serverRequestDisposables.set(RegistrationRequest.method, connection.onRequest(RegistrationRequest.type, (params) => {
			validatedProtocolResult(() => this.protocol.registerCapabilities(params));
		}));
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

	private async markTransportFailure(message: string): Promise<void> {
		if (this.state === "stopped" || this.state === "unavailable" || this.state === "crashed") {
			await this.cleanupPromise;
			return;
		}
		const failure = compactError(this.transportFailureMessage(message));
		const crashed = this.state === "ready";
		this.state = crashed ? "crashed" : "unavailable";
		this.lastError = failure;
		this.clearIdleTimer();
		this.rejectTransportWaiters(failure);
		if (crashed) this.onCrash(this, failure);
		await this.cleanupCurrentSession();
	}

	private async cleanupCurrentSession(): Promise<void> {
		if (this.cleanupPromise !== undefined) return this.cleanupPromise;
		const connection = this.connection;
		const transport = this.transport;
		this.connection = undefined;
		this.transport = undefined;
		this.serverCapabilities = undefined;
		this.documents.clear();
		this.diagnosticResultIds.clear();
		this.protocol.reset();
		this.disposeServerRequestDisposables();
		connection?.dispose();
		const pending = (async () => {
			if (transport !== undefined) await transport.close();
		})();
		this.cleanupPromise = pending;
		try {
			await pending;
		} finally {
			if (this.cleanupPromise === pending) this.cleanupPromise = undefined;
		}
	}

	private transportFailureMessage(message: string): string {
		const stderr = this.transport?.stderrTail();
		return stderr === undefined || message.includes(stderr) ? message : `${message}; stderr: ${stderr}`;
	}

	private rejectTransportWaiters(message: string): void {
		const error = new Error(message);
		for (const reject of this.transportFailureRejectors) reject(error);
		this.transportFailureRejectors.clear();
	}

	private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
		this.inFlightOperations += 1;
		this.clearIdleTimer();
		try {
			return await operation();
		} finally {
			this.inFlightOperations -= 1;
			this.bumpIdleTimer();
		}
	}

	private bumpIdleTimer(): void {
		this.clearIdleTimer();
		if (this.state !== "ready" || this.inFlightOperations > 0 || this.config.idle_timeout_ms <= 0) return;
		this.idleTimer = setTimeout(() => {
			if (this.inFlightOperations === 0 && this.state === "ready") void this.shutdown();
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
			throw error;
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

function validatedProtocolResult<T>(factory: () => T): T {
	try {
		return factory();
	} catch (error) {
		if (error instanceof LspProtocolValidationError) throw new ResponseError(ErrorCodes.InvalidParams, error.message);
		throw error;
	}
}

function isWorkDoneProgressCreateParams(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const token = Reflect.get(value, "token");
	return typeof token === "string" || typeof token === "number";
}

function isProgressNotification(value: unknown): value is LspProgressNotification {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (typeof record.token === "string" || typeof record.token === "number") && "value" in record;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compactError(message: string): string {
	const normalized = message.replace(/\s+/g, " ").trim();
	if (normalized.length <= LAST_ERROR_MAX_CHARS) return normalized;
	const marker = " ...[truncated]... ";
	const headLength = 256;
	const tailLength = LAST_ERROR_MAX_CHARS - headLength - marker.length;
	return `${normalized.slice(0, headLength)}${marker}${normalized.slice(-tailLength)}`;
}
