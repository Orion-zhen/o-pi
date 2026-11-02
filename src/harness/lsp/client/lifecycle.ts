import {
	DidChangeConfigurationNotification,
	DidChangeWatchedFilesNotification,
	InitializedNotification,
	type FileChangeType,
	type InitializeParams,
} from "vscode-languageserver-protocol";

import { LspClientConnection, type ReadyLspConnection } from "./connection.ts";
import { LspClientSession } from "./session.ts";
import type { DiagnosticsLedger } from "../diagnostics/ledger.ts";
import { LspProtocolInfrastructure } from "../protocol/infrastructure.ts";
import { connectLspTransport } from "../protocol/transport.ts";
import type { LspConfig, LspServerConfig, LspServerStatus } from "../types.ts";
import { pathToFileUri } from "../protocol/uri.ts";

const LAST_ERROR_MAX_CHARS = 1024;

type SessionStart = Promise<LspClientSession | undefined>;
interface ConnectingState { kind: "connecting"; pending: SessionStart }
type State =
	| { kind: "idle" | "stopped" }
	| ConnectingState
	| { kind: "initializing"; pending: SessionStart; connection: LspClientConnection }
	| { kind: "configuring"; pending: SessionStart; session: LspClientSession }
	| { kind: "ready"; session: LspClientSession }
	| { kind: "stopping"; pending: Promise<void> }
	| { kind: "unavailable" | "crashed"; error: string; closed: Promise<void> };

/** 状态独占对应资源，业务操作只能取得已完成握手的会话。 */
export class LspClientLifecycle {
	private state: State = { kind: "idle" };
	private idleTimer: NodeJS.Timeout | undefined;
	private inFlightOperations = 0;

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		private readonly config: LspConfig,
		private readonly ledger: DiagnosticsLedger,
		private readonly onCrash: (message: string) => void,
	) {}

	status(): LspServerStatus["status"] {
		const { kind } = this.state;
		if (kind === "connecting" || kind === "initializing" || kind === "configuring") return "starting";
		return kind === "stopping" ? "stopped" : kind;
	}

	session(): LspClientSession | undefined {
		return this.state.kind === "ready" ? this.state.session : undefined;
	}

	lastErrorMessage(): string | undefined {
		if (this.state.kind === "unavailable" || this.state.kind === "crashed") return this.state.error;
		const message = this.session()?.connection.lastErrorMessage();
		return message === undefined ? undefined : compactError(message);
	}

	async ensureReady(): Promise<LspClientSession | undefined> {
		const state = this.state;
		switch (state.kind) {
			case "stopping":
				await state.pending;
				return this.ensureReady();
			case "ready":
				this.bumpIdleTimer();
				return state.session;
			case "unavailable":
			case "crashed":
				return undefined;
			case "connecting":
			case "initializing":
			case "configuring":
				return state.pending;
			case "idle":
			case "stopped": {
				const connecting: ConnectingState = {
					kind: "connecting", pending: Promise.resolve().then(() => this.start(connecting)),
				};
				this.state = connecting;
				return connecting.pending;
			}
		}
	}

	shutdown(): Promise<void> {
		const state = this.state;
		if (state.kind === "stopping") return state.pending;
		this.clearIdleTimer();
		const pending = Promise.resolve().then(() => this.close(state)).finally(() => {
			this.state = { kind: "stopped" };
		});
		this.state = { kind: "stopping", pending };
		return pending;
	}

	withSession<T>(operation: (session: LspClientSession) => Promise<T>): Promise<T | undefined> {
		return this.withOperation(async () => {
			const session = await this.ensureReady();
			return session === undefined ? undefined : operation(session);
		});
	}

	async didChangeWatchedFiles(changes: readonly { filePath: string; type: FileChangeType }[]): Promise<boolean> {
		if (this.state.kind !== "ready") return false;
		const { connection } = this.state.session;
		const events = changes.flatMap((change) => {
			const event = connection.protocol.watchedFileEvent(change.filePath, change.type);
			return event === undefined ? [] : [event];
		});
		if (events.length === 0) return false;
		return this.withOperation(() => connection.notify((rpc) => rpc.sendNotification(
			DidChangeWatchedFilesNotification.type, { changes: events },
		)));
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
		if (this.state.kind !== "ready" || this.inFlightOperations > 0 || this.config.idle_timeout_ms <= 0) return;
		this.idleTimer = setTimeout(() => { void this.shutdown(); }, this.config.idle_timeout_ms);
		this.idleTimer.unref();
	}

	private async close(state: Exclude<State, { kind: "stopping" }>): Promise<void> {
		switch (state.kind) {
			case "connecting":
				await state.pending;
				return;
			case "initializing":
			case "configuring":
			case "ready": {
				const connection = state.kind === "initializing" ? state.connection : state.session.connection;
				connection.stop();
				try {
					if (state.kind !== "ready") await state.pending;
				} finally {
					try {
						await connection.close(this.config.request_timeout_ms);
					} finally {
						if (state.kind !== "initializing") state.session.dispose();
					}
				}
				return;
			}
			case "unavailable":
			case "crashed":
				await state.closed;
				return;
			case "idle":
			case "stopped":
				return;
		}
	}

	private async start(connecting: ConnectingState): Promise<LspClientSession | undefined> {
		let transport: Awaited<ReturnType<typeof connectLspTransport>>;
		try {
			transport = await connectLspTransport(this.server.transport, this.root, this.config.startup_timeout_ms);
		} catch (error) {
			if (this.state === connecting) this.state = {
				kind: "unavailable", error: compactError(errorMessage(error)), closed: Promise.resolve(),
			};
			return undefined;
		}
		if (this.state !== connecting) {
			await transport.close();
			return undefined;
		}
		const connection = new LspClientConnection(
			transport,
			this.config.request_timeout_ms,
			new LspProtocolInfrastructure(this.root, this.server.settings),
			(message) => this.markTransportFailure(connection, message),
		);
		const initializing = { kind: "initializing" as const, connection, pending: connecting.pending };
		this.state = initializing;
		connection.rpc.listen();
		let ready: ReadyLspConnection;
		try {
			ready = await connection.initialize(initializeParams(this.root, this.server, connection), this.config.startup_timeout_ms);
		} catch (error) {
			await this.markTransportFailure(connection, errorMessage(error));
			return undefined;
		}
		if (this.state !== initializing) return undefined;
		const session = new LspClientSession(this.root, this.server, this.config, this.ledger, ready);
		const configuring = { kind: "configuring" as const, session, pending: connecting.pending };
		this.state = configuring;
		if (!await connection.notify((rpc) => rpc.sendNotification(InitializedNotification.type, {}))) return undefined;
		const settings = connection.protocol.configurationSettings();
		if (settings !== undefined && !await connection.notify((rpc) => rpc.sendNotification(DidChangeConfigurationNotification.type, { settings }))) return undefined;
		if (this.state !== configuring) return undefined;
		this.state = { kind: "ready", session };
		this.bumpIdleTimer();
		return session;
	}

	private async markTransportFailure(connection: LspClientConnection, message: string): Promise<void> {
		const state = this.state;
		if (state.kind !== "initializing" && state.kind !== "configuring" && state.kind !== "ready") return;
		const current = state.kind === "initializing" ? state.connection : state.session.connection;
		if (current !== connection) return;
		const stderr = connection.stderrTail();
		const error = compactError(stderr === undefined || message.includes(stderr) ? message : `${message}; stderr: ${stderr}`);
		const closed = connection.abort();
		this.state = { kind: state.kind === "ready" ? "crashed" : "unavailable", error, closed };
		this.clearIdleTimer();
		if (state.kind !== "initializing") state.session.dispose();
		if (state.kind === "ready") this.onCrash(error);
		await closed;
	}

	private clearIdleTimer(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
}

function initializeParams(root: string, server: LspServerConfig, connection: LspClientConnection): InitializeParams {
	return {
		processId: server.transport.type === "tcp" ? null : process.pid,
		rootUri: pathToFileUri(root),
		workspaceFolders: connection.protocol.workspaceFolders(),
		capabilities: {
			textDocument: {
				synchronization: { didSave: true },
				documentSymbol: { hierarchicalDocumentSymbolSupport: true },
				references: { dynamicRegistration: false },
				definition: { dynamicRegistration: false, linkSupport: true },
				callHierarchy: { dynamicRegistration: false },
				diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
				publishDiagnostics: { relatedInformation: true, dataSupport: true },
				codeAction: {
					codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix"] } },
					disabledSupport: true,
				},
			},
			workspace: {
				configuration: true,
				workspaceFolders: true,
				didChangeConfiguration: { dynamicRegistration: true },
				didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
				symbol: { resolveSupport: { properties: ["location.range"] } },
			},
		},
		initializationOptions: server.initializationOptions,
	};
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
