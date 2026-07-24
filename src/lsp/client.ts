import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type Message,
	type MessageConnection,
	type MessageWriter,
} from "vscode-jsonrpc/node";
import {
	DidChangeTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DidSaveTextDocumentNotification,
	DocumentSymbolRequest,
	ExitNotification,
	InitializedNotification,
	InitializeRequest,
	PublishDiagnosticsNotification,
	ReferencesRequest,
	ShutdownRequest,
	WorkspaceSymbolRequest,
	type Diagnostic,
	type Location,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { DiagnosticsLedger } from "./diagnostics.js";
import { LspDocuments } from "./documents.js";
import { connectLspTransport, type LspTransportConnection } from "./transport.js";
import type { LspConfig, LspDocumentSymbols, LspServerConfig, LspServerStatus } from "./types.js";
import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "./uri.js";

/** 单个 language server client，封装 transport、initialize、文档同步、symbol 和诊断通知。 */
export class LspClient {
	private transport: LspTransportConnection | undefined;
	private connection: MessageConnection | undefined;
	private state: LspServerStatus["status"] = "idle";
	private lastError: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private readonly transportFailureRejectors = new Set<(error: Error) => void>();
	private readonly documents = new LspDocuments();

	constructor(
		readonly root: string,
		readonly server: LspServerConfig,
		private readonly config: LspConfig,
		private readonly diagnostics: DiagnosticsLedger,
		private readonly onCrash: (client: LspClient, message: string) => void,
		private readonly getRestartCount: () => number,
	) {}

	status(): LspServerStatus {
		const status: LspServerStatus = {
			id: this.server.id,
			root: this.root,
			status: this.state,
			restarts: this.getRestartCount(),
			open_documents: this.documents.count(),
			diagnostics: this.diagnostics.all().reduce((sum, entry) => {
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
		this.documents.clear();
		if (connection !== undefined) {
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
		if (transport !== undefined) await transport.close();
	}

	async didOpenOrChange(filePath: string, text: string): Promise<boolean> {
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		const document = this.documents.context(filePath, text, this.server.language_id);
		const version = this.documents.nextVersion(document.uri);
		if (version === 1) {
			const sent = await this.sendNotification(connection, (active) => active.sendNotification(DidOpenTextDocumentNotification.type, {
				textDocument: {
					uri: document.uri,
					languageId: document.languageId,
					version,
					text: document.text,
				},
			}));
			if (!sent) return false;
		} else {
			const sent = await this.sendNotification(connection, (active) => active.sendNotification(DidChangeTextDocumentNotification.type, {
				textDocument: { uri: document.uri, version },
				contentChanges: [{ text: document.text }],
			}));
			if (!sent) return false;
		}
		this.bumpIdleTimer();
		return true;
	}

	async didSave(filePath: string, text: string): Promise<boolean> {
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		const sent = await this.sendNotification(connection, (active) => active.sendNotification(DidSaveTextDocumentNotification.type, { textDocument: { uri: this.documents.context(filePath, text, this.server.language_id).uri }, text }));
		if (!sent) return false;
		this.bumpIdleTimer();
		return true;
	}

	async documentSymbols(filePath: string, text: string): Promise<LspDocumentSymbols | undefined> {
		const opened = await this.didOpenOrChange(filePath, text);
		if (!opened) return undefined;
		const connection = this.connection;
		if (connection === undefined) return undefined;
		const uri = this.documents.context(filePath, text, this.server.language_id).uri;
		return (await this.request(() => connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri } }))) ?? undefined;
	}

	async workspaceSymbols(query: string): Promise<Array<SymbolInformation | WorkspaceSymbol> | undefined> {
		const connection = await this.readyConnection();
		if (connection === undefined) return undefined;
		return (await this.request(() => connection.sendRequest(WorkspaceSymbolRequest.type, { query }))) ?? undefined;
	}

	async references(uri: string, line: number, character: number): Promise<Location[] | undefined> {
		const connection = await this.readyConnection();
		if (connection === undefined) return undefined;
		return (await this.request(() => connection.sendRequest(ReferencesRequest.type, {
			textDocument: { uri },
			position: { line, character },
			context: { includeDeclaration: false },
		}))) ?? undefined;
	}

	private async readyConnection(): Promise<MessageConnection | undefined> {
		const ready = await this.ensureReady();
		if (!ready) return undefined;
		return this.connection;
	}

	private async start(): Promise<boolean> {
		this.state = "starting";
		this.lastError = undefined;
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
			this.diagnostics.update(params.uri, params.diagnostics as Diagnostic[], this.config.diagnostics.min_severity);
		});
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
			await withTimeout(
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
						workspace: { symbol: { resolveSupport: { properties: [] } } },
					},
					initializationOptions: this.server.initialization_options,
				})),
				this.config.startup_timeout_ms,
			);
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

	private async request<T>(factory: () => Promise<T>): Promise<T | undefined> {
		try {
			const result = await withTimeout(this.withTransportFailure(factory), this.config.request_timeout_ms);
			this.bumpIdleTimer();
			return result;
		} catch (error) {
			this.lastError = errorMessage(error);
			return undefined;
		}
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
