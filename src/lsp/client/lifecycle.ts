import {
	DidChangeConfigurationNotification,
	DidChangeWatchedFilesNotification,
	InitializedNotification,
	type FileChangeType,
} from "vscode-languageserver-protocol";

import { LspClientConnection } from "./connection.js";
import { LspProtocolInfrastructure } from "../protocol/infrastructure.js";
import { connectLspTransport } from "../protocol/transport.js";
import type { LspConfig, LspServerConfig, LspServerStatus } from "../types.js";
import { pathToFileUri } from "../protocol/uri.js";

const LAST_ERROR_MAX_CHARS = 1024;

export interface LspClientLifecycleHandlers {
	onConnection(connection: LspClientConnection): void;
	onCleanup(): void;
	onCrash(message: string): void;
}

/** 管理共享启动、停止、故障状态和空闲退出，业务请求属于各自连接代。 */
export class LspClientLifecycle {
	private activeConnection: LspClientConnection | undefined;
	private state: LspServerStatus["status"] = "idle";
	private lastError: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private startPromise: Promise<boolean> | undefined;
	private stopPromise: Promise<void> | undefined;
	private cleanupPromise: Promise<void> | undefined;
	private inFlightOperations = 0;

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		private readonly config: LspConfig,
		private readonly handlers: LspClientLifecycleHandlers,
	) {}

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

	async didChangeWatchedFiles(changes: readonly { filePath: string; type: FileChangeType }[]): Promise<boolean> {
		const connection = this.activeConnection;
		if (this.state !== "ready" || connection === undefined) return false;
		const events = changes.flatMap((change) => {
			const event = connection.protocol.watchedFileEvent(change.filePath, change.type);
			return event === undefined ? [] : [event];
		});
		if (events.length === 0) return false;
		return this.withOperation(() => connection.notify((rpc) => rpc.sendNotification(
			DidChangeWatchedFilesNotification.type, { changes: events },
		)));
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

	private bumpIdleTimer(): void {
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
		this.activeConnection?.stop();
		await this.startPromise;
		await this.cleanupPromise;
		const connection = this.activeConnection;
		this.activeConnection = undefined;
		try {
			if (connection !== undefined) await connection.close(this.config.request_timeout_ms);
		} finally {
			this.handlers.onCleanup();
		}
	}

	private async start(): Promise<boolean> {
		this.state = "starting";
		this.lastError = undefined;
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
		const connection = new LspClientConnection(
			transport,
			this.config.request_timeout_ms,
			new LspProtocolInfrastructure(this.root, this.server.settings),
			async (message) => {
				if (this.activeConnection === connection) await this.markTransportFailure(message);
			},
			(message) => {
				if (this.activeConnection === connection) this.lastError = message;
			},
		);
		this.activeConnection = connection;
		this.handlers.onConnection(connection);
		connection.rpc.listen();

		try {
			await connection.initialize({
				processId: this.server.transport.type === "tcp" ? null : process.pid,
				rootUri: pathToFileUri(this.root),
				workspaceFolders: connection.protocol.workspaceFolders(),
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
			}, this.config.startup_timeout_ms);
			if (this.activeConnection !== connection || this.state !== "starting") return false;
			const initialized = await connection.notify((rpc) => rpc.sendNotification(InitializedNotification.type, {}));
			if (!initialized) throw new Error("failed to send initialized notification");
			const settings = connection.protocol.configurationSettings();
			if (settings !== undefined) {
				const configured = await connection.notify((rpc) => rpc.sendNotification(DidChangeConfigurationNotification.type, { settings }));
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

	private async markTransportFailure(message: string): Promise<void> {
		if (this.state === "stopped" || this.state === "unavailable" || this.state === "crashed") {
			await this.cleanupPromise;
			return;
		}
		const stderr = this.activeConnection?.stderrTail();
		const failure = compactError(stderr === undefined || message.includes(stderr) ? message : `${message}; stderr: ${stderr}`);
		const crashed = this.state === "ready";
		this.state = crashed ? "crashed" : "unavailable";
		this.lastError = failure;
		this.clearIdleTimer();
		if (crashed) this.handlers.onCrash(failure);
		await this.cleanupCurrentConnection();
	}

	private async cleanupCurrentConnection(): Promise<void> {
		if (this.cleanupPromise !== undefined) return this.cleanupPromise;
		const connection = this.activeConnection;
		this.activeConnection = undefined;
		this.handlers.onCleanup();
		const pending = connection === undefined ? Promise.resolve() : connection.abort();
		this.cleanupPromise = pending;
		try {
			await pending;
		} finally {
			if (this.cleanupPromise === pending) this.cleanupPromise = undefined;
		}
	}

	private clearIdleTimer(): void {
		if (this.idleTimer === undefined) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
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
