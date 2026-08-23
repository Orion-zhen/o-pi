import path from "node:path";
import {
	CancellationTokenSource,
	ErrorCodes,
	ResponseError,
	type Disposable,
	type MessageConnection,
	type RequestType,
} from "vscode-jsonrpc/node";
import {
	ConfigurationRequest,
	DidChangeConfigurationNotification,
	DidChangeWatchedFilesNotification,
	InitializedNotification,
	InitializeRequest,
	PublishDiagnosticsNotification,
	RegistrationRequest,
	WorkspaceFoldersRequest,
	type Diagnostic,
	type FileChangeType,
	type InitializeResult,
	type ServerCapabilities,
} from "vscode-languageserver-protocol";

import { LspClientConnection } from "./connection.js";
import { LspProtocolInfrastructure, LspProtocolValidationError } from "../protocol/infrastructure.js";
import type { LspClientTransport } from "./transport.js";
import { connectLspTransport } from "../protocol/transport.js";
import { withTimeout } from "../protocol/timeout.js";
import type { LspConfig, LspRequestOptions, LspServerConfig, LspServerStatus } from "../types.js";
import { pathToFileUri } from "../protocol/uri.js";

const LAST_ERROR_MAX_CHARS = 1024;

export interface LspClientLifecycleHandlers {
	onPublishDiagnostics(params: { uri: string; diagnostics: Diagnostic[]; version?: number }): void;
	onCleanup(): void;
	onCrash(message: string): void;
}

/** 管理单个 language server 的 transport、协议握手、故障和空闲生命周期。 */
export class LspClientLifecycle implements LspClientTransport {
	private activeConnection: LspClientConnection | undefined;
	private serverCapabilities: ServerCapabilities | undefined;
	private state: LspServerStatus["status"] = "idle";
	private lastError: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private startPromise: Promise<boolean> | undefined;
	private stopPromise: Promise<void> | undefined;
	private cleanupPromise: Promise<void> | undefined;
	private inFlightOperations = 0;
	private readonly transportFailureRejectors = new Set<(error: Error) => void>();
	private readonly serverRequestDisposables = new Map<string, Disposable>();

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		private readonly config: LspConfig,
		private readonly protocol: LspProtocolInfrastructure,
		private readonly handlers: LspClientLifecycleHandlers,
	) {}

	capabilities(): ServerCapabilities | undefined {
		return this.serverCapabilities;
	}

	status(): LspServerStatus["status"] {
		return this.state;
	}

	lastErrorMessage(): string | undefined {
		return this.lastError === undefined ? undefined : compactError(this.lastError);
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

	async request<P, R, E>(type: RequestType<P, R, E>, params: P, options: LspRequestOptions = {}): Promise<R | undefined> {
		return this.withOperation(async () => {
			const connection = await this.readyConnection();
			return connection === undefined ? undefined : this.requestOnConnection(connection, type, params, options);
		});
	}

	async didChangeWatchedFiles(changes: readonly { filePath: string; type: FileChangeType }[]): Promise<boolean> {
		if (this.state !== "ready") return false;
		const events = changes.flatMap((change) => {
			const event = this.protocol.watchedFileEvent(change.filePath, change.type);
			return event === undefined ? [] : [event];
		});
		if (events.length === 0) return false;
		return this.withOperation(async () => {
			const connection = this.activeConnection?.rpc;
			if (connection === undefined || this.state !== "ready") return false;
			return this.sendNotification(connection, (active) => active.sendNotification(
				DidChangeWatchedFilesNotification.type,
				{ changes: events },
			));
		});
	}

	async withOperation<T>(operation: () => Promise<T>): Promise<T> {
		this.inFlightOperations += 1;
		this.clearIdleTimer();
		try {
			return await operation();
		} finally {
			this.inFlightOperations -= 1;
			this.bumpIdleTimer();
		}
	}

	async readyConnection(): Promise<MessageConnection | undefined> {
		const ready = await this.ensureReady();
		if (!ready) return undefined;
		return this.activeConnection?.rpc;
	}

	async requestOnConnection<P, R, E>(
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

	async sendNotification(
		connection: MessageConnection,
		factory: (connection: MessageConnection) => Promise<void>,
	): Promise<boolean> {
		if (this.activeConnection?.rpc !== connection || !this.canUseConnection()) return false;
		try {
			await withTimeout(this.withTransportFailure(() => factory(connection)), this.config.request_timeout_ms);
			return this.activeConnection?.rpc === connection && this.canUseConnection();
		} catch (error) {
			await this.markTransportFailure(errorMessage(error));
			return false;
		}
	}

	bumpIdleTimer(): void {
		this.clearIdleTimer();
		if (this.state !== "ready" || this.inFlightOperations > 0 || this.config.idle_timeout_ms <= 0) return;
		this.idleTimer = setTimeout(() => {
			if (this.inFlightOperations === 0 && this.state === "ready") void this.shutdown();
		}, this.config.idle_timeout_ms);
		this.idleTimer.unref();
	}

	private async performShutdown(): Promise<void> {
		this.clearIdleTimer();
		this.state = "stopped";
		this.rejectTransportWaiters("server stopped");
		await this.startPromise;
		await this.cleanupPromise;

		const activeConnection = this.activeConnection;
		this.activeConnection = undefined;
		this.serverCapabilities = undefined;
		this.disposeServerRequestDisposables();

		try {
			if (activeConnection !== undefined) await activeConnection.close(this.config.request_timeout_ms);
		} finally {
			this.protocol.reset();
			this.handlers.onCleanup();
		}
	}

	private async start(): Promise<boolean> {
		this.state = "starting";
		this.lastError = undefined;
		this.serverCapabilities = undefined;
		let transport: Awaited<ReturnType<typeof connectLspTransport>>;
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
		let activeConnection: LspClientConnection | undefined;
		activeConnection = new LspClientConnection(transport, (error) => {
			if (activeConnection === undefined || this.activeConnection !== activeConnection) return;
			void this.markTransportFailure(errorMessage(error));
		});
		const connection = activeConnection.rpc;
		this.activeConnection = activeConnection;
		void activeConnection.failure.catch((error) => {
			if (this.activeConnection !== activeConnection) return;
			void this.markTransportFailure(errorMessage(error));
		});
		connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
			this.handlers.onPublishDiagnostics({
				uri: params.uri,
				diagnostics: params.diagnostics as Diagnostic[],
				...(params.version === undefined ? {} : { version: params.version }),
			});
		});
		connection.onRequest((method, _params, _token) => {
			throw new ResponseError(ErrorCodes.MethodNotFound, `Unsupported server request: ${method}`);
		});
		this.installProtocolServerRequestHandlers(connection);
		connection.onError(([error]) => {
			if (this.activeConnection !== activeConnection) return;
			void this.markTransportFailure(error.message);
		});
		connection.onClose(() => {
			if (this.activeConnection !== activeConnection) return;
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
							callHierarchy: { dynamicRegistration: false },
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
					},
					initializationOptions: this.server.initializationOptions,
				})),
				this.config.startup_timeout_ms,
			) as InitializeResult;
			if (this.activeConnection !== activeConnection || this.state !== "starting") return false;
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

	private async withTransportFailure<T>(factory: () => Promise<T>): Promise<T> {
		let rejectTransport: ((error: Error) => void) | undefined;
		const localFailure = new Promise<never>((_resolve, reject) => {
			rejectTransport = reject;
			this.transportFailureRejectors.add(reject);
		});
		const transportFailure = this.activeConnection?.failure;
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
		this.serverRequestDisposables.set(RegistrationRequest.method, connection.onRequest(RegistrationRequest.type, (params) => {
			validatedProtocolResult(() => this.protocol.registerCapabilities(params));
		}));
	}

	private disposeServerRequestDisposables(): void {
		for (const disposable of this.serverRequestDisposables.values()) disposable.dispose();
		this.serverRequestDisposables.clear();
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
		if (crashed) this.handlers.onCrash(failure);
		await this.cleanupCurrentConnection();
	}

	private async cleanupCurrentConnection(): Promise<void> {
		if (this.cleanupPromise !== undefined) return this.cleanupPromise;
		const activeConnection = this.activeConnection;
		this.activeConnection = undefined;
		this.serverCapabilities = undefined;
		this.protocol.reset();
		this.disposeServerRequestDisposables();
		this.handlers.onCleanup();
		const pending = (async () => {
			if (activeConnection !== undefined) await activeConnection.abort();
		})();
		this.cleanupPromise = pending;
		try {
			await pending;
		} finally {
			if (this.cleanupPromise === pending) this.cleanupPromise = undefined;
		}
	}

	private transportFailureMessage(message: string): string {
		const stderr = this.activeConnection?.stderrTail();
		return stderr === undefined || message.includes(stderr) ? message : `${message}; stderr: ${stderr}`;
	}

	private rejectTransportWaiters(message: string): void {
		const error = new Error(message);
		for (const reject of this.transportFailureRejectors) reject(error);
		this.transportFailureRejectors.clear();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer === undefined) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
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
