import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
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
	TextDocumentSyncKind,
	WorkspaceSymbolRequest,
	type Diagnostic,
	type DocumentSymbol,
	type InitializeResult,
	type Location,
	type SymbolInformation,
	type WorkspaceSymbol,
} from "vscode-languageserver-protocol";

import type { DiagnosticsLedger } from "./diagnostics.js";
import { LspDocuments } from "./documents.js";
import type { LspConfig, LspDocumentSymbols, LspServerConfig, LspServerStatus } from "./types.js";
import { fileUriToPath } from "./uri.js";

/** 单个 stdio language server client，封装 initialize、文档同步、symbol 和诊断通知。 */
export class LspClient {
	private process: ChildProcessWithoutNullStreams | undefined;
	private connection: MessageConnection | undefined;
	private state: LspServerStatus["status"] = "idle";
	private lastError: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private textDocumentSync: TextDocumentSyncKind | undefined;
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
				return filePath !== undefined && isUnderRoot(this.root, filePath) ? sum + entry.items.length : sum;
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
		const child = this.process;
		this.connection = undefined;
		this.process = undefined;
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
		if (child !== undefined && !child.killed) child.kill();
		this.state = "stopped";
	}

	async didOpenOrChange(filePath: string, text: string): Promise<boolean> {
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		const document = this.documents.context(filePath, text);
		const version = this.documents.nextVersion(document.uri);
		if (!this.documents.has(document.uri) || version === 1) {
			connection.sendNotification(DidOpenTextDocumentNotification.type, {
				textDocument: {
					uri: document.uri,
					languageId: document.languageId,
					version,
					text: document.text,
				},
			});
		} else {
			connection.sendNotification(DidChangeTextDocumentNotification.type, {
				textDocument: { uri: document.uri, version },
				contentChanges: [{ text: document.text }],
			});
		}
		this.bumpIdleTimer();
		return true;
	}

	async didSave(filePath: string, text: string): Promise<boolean> {
		const connection = await this.readyConnection();
		if (connection === undefined) return false;
		connection.sendNotification(DidSaveTextDocumentNotification.type, { textDocument: { uri: this.documents.context(filePath, text).uri }, text });
		this.bumpIdleTimer();
		return true;
	}

	async documentSymbols(filePath: string, text: string): Promise<LspDocumentSymbols | undefined> {
		const opened = await this.didOpenOrChange(filePath, text);
		if (!opened) return undefined;
		const connection = this.connection;
		if (connection === undefined) return undefined;
		const uri = this.documents.context(filePath, text).uri;
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
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(this.server.command, this.server.args, { cwd: this.root, stdio: "pipe" });
		} catch (error) {
			this.markUnavailable(errorMessage(error));
			return false;
		}
		this.process = child;

		const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
		this.connection = connection;
		connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
			this.diagnostics.update(params.uri, params.diagnostics as Diagnostic[], this.config.diagnostics.min_severity);
		});
		connection.listen();

		child.once("error", (error) => {
			this.markUnavailable(error.message);
			this.onCrash(this, error.message);
		});
		child.once("exit", (code, signal) => {
			if (this.state === "stopped" || this.state === "unavailable") return;
			const message = `server exited${code === null ? "" : ` ${code}`}${signal === null ? "" : ` ${signal}`}`;
			this.state = "crashed";
			this.lastError = message;
			this.onCrash(this, message);
		});

		try {
			const result = await withTimeout(
				connection.sendRequest(InitializeRequest.type, {
					processId: process.pid,
					rootUri: pathToRootUri(this.root),
					workspaceFolders: [{ uri: pathToRootUri(this.root), name: path.basename(this.root) || this.root }],
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
				}),
				this.config.startup_timeout_ms,
			);
			this.textDocumentSync = syncKind(result);
			connection.sendNotification(InitializedNotification.type, {});
			this.state = "ready";
			this.bumpIdleTimer();
			return true;
		} catch (error) {
			this.markUnavailable(errorMessage(error));
			connection.dispose();
			if (!child.killed) child.kill();
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
			const result = await withTimeout(factory(), this.config.request_timeout_ms);
			this.bumpIdleTimer();
			return result;
		} catch (error) {
			this.lastError = errorMessage(error);
			return undefined;
		}
	}

	private markUnavailable(message: string): void {
		this.state = "unavailable";
		this.lastError = message;
		this.clearIdleTimer();
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

function syncKind(result: InitializeResult): TextDocumentSyncKind | undefined {
	const sync = result.capabilities.textDocumentSync;
	if (typeof sync === "number") return sync;
	if (typeof sync === "object" && sync !== null && typeof sync.change === "number") return sync.change;
	return undefined;
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

function pathToRootUri(root: string): string {
	return pathToFileURL(path.resolve(root)).toString();
}

function isUnderRoot(root: string, filePath: string): boolean {
	const relative = path.relative(root, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
