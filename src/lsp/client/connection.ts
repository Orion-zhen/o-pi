import {
	CancellationTokenSource,
	ErrorCodes,
	ResponseError,
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type Message,
	type MessageConnection,
	type MessageWriter,
	type RequestType,
	type RequestParam,
} from "vscode-jsonrpc/node";
import {
	ConfigurationRequest, ExitNotification, InitializeRequest, RegistrationRequest, ShutdownRequest, WorkspaceFoldersRequest,
	type InitializeParams, type ServerCapabilities,
} from "vscode-languageserver-protocol";

import type { LspTransportConnection } from "../protocol/transport.js";
import type { LspFeatureSession } from "../protocol/features.js";
import { withTimeout } from "../protocol/timeout.js";
import { LspProtocolInfrastructure, LspProtocolValidationError } from "../protocol/infrastructure.js";
import type { LspRequestOptions } from "../types.js";

const MIN_GRACEFUL_CLOSE_MS = 1000;
const MAX_GRACEFUL_CLOSE_MS = 3000;
const POST_CLOSE_DRAIN_MS = 1000;

/** 一代协议连接独占能力、请求取消、故障信号、writer 和底层资源。 */
export class LspClientConnection implements LspFeatureSession {
	readonly rpc: MessageConnection;
	private readonly failure: Promise<never>;
	private readonly failureHandled: Promise<void>;
	private readonly writer: DrainingMessageWriter;
	private closePromise: Promise<void> | undefined;
	private serverCapabilities: ServerCapabilities | undefined;
	private usable = true;
	private rejectFailure: (error: Error) => void = () => undefined;

	constructor(
		private readonly transport: LspTransportConnection,
		private readonly requestTimeoutMs: number,
		readonly protocol: LspProtocolInfrastructure,
		onFailure: (message: string) => Promise<void>,
		private readonly onRequestError: (message: string) => void,
	) {
		const localFailure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
		this.failure = Promise.race([localFailure, transport.failure]);
		this.failureHandled = this.failure.catch(async (error: unknown) => {
			this.usable = false;
			await onFailure(errorMessage(error));
		});
		this.writer = new DrainingMessageWriter(new StreamMessageWriter(transport.writer), (error) => this.fail(error));
		this.rpc = createMessageConnection(new StreamMessageReader(transport.reader), this.writer);
		this.rpc.onError(([error]) => this.fail(error));
		this.rpc.onClose(() => this.fail(new Error("connection closed")));
		this.rpc.onRequest((method) => {
			throw new ResponseError(ErrorCodes.MethodNotFound, `Unsupported server request: ${method}`);
		});
		this.rpc.onRequest(ConfigurationRequest.type, (params) => validatedProtocolResult(() => protocol.configuration(params)));
		this.rpc.onRequest(WorkspaceFoldersRequest.type, () => protocol.workspaceFolders());
		this.rpc.onRequest(RegistrationRequest.type, (params) => {
			validatedProtocolResult(() => protocol.registerCapabilities(params));
		});
	}

	capabilities(): ServerCapabilities | undefined {
		return this.serverCapabilities;
	}

	async initialize(params: InitializeParams, timeoutMs: number): Promise<void> {
		const result = await withTimeout(Promise.race([
			this.rpc.sendRequest(InitializeRequest.type, params), this.failure,
		]), timeoutMs);
		this.serverCapabilities = result.capabilities;
	}

	async request<P, R, E>(type: RequestType<P, R, E>, params: NoInfer<RequestParam<P>>, options: LspRequestOptions = {}): Promise<R | undefined> {
		if (!this.usable) return undefined;
		const source = new CancellationTokenSource();
		let rejectCancellation: (error: Error) => void = () => undefined;
		const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
		const cancel = (message: string): void => {
			source.cancel();
			rejectCancellation(new Error(message));
		};
		const onAbort = (): void => cancel("request cancelled");
		if (options.signal?.aborted === true) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => cancel("timeout"), options.timeoutMs ?? this.requestTimeoutMs);
		try {
			return await Promise.race([
				this.rpc.sendRequest(type, params, source.token), this.failure, cancelled,
			]);
		} catch (error) {
			this.onRequestError(errorMessage(error));
			return undefined;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			source.dispose();
		}
	}

	async notify(factory: (rpc: MessageConnection) => Promise<void>): Promise<boolean> {
		if (!this.usable) return false;
		try {
			await withTimeout(Promise.race([factory(this.rpc), this.failure]), this.requestTimeoutMs);
			return this.usable;
		} catch (error) {
			this.fail(error);
			await this.failureHandled;
			return false;
		}
	}

	/** 停止业务请求，不影响随后通过原始 RPC 发送 shutdown/exit。 */
	stop(): void {
		this.fail(new Error("server stopped"));
	}

	private fail(error: unknown): void {
		if (!this.usable) return;
		this.usable = false;
		this.rejectFailure(error instanceof Error ? error : new Error(String(error)));
	}

	stderrTail(): string | undefined {
		return this.transport.stderrTail();
	}

	/** 发送 shutdown/exit 并给 server 一个共享的绝对退出期限。 */
	close(timeoutMs: number): Promise<void> {
		return this.startClose(true, timeoutMs);
	}

	/** transport 已失败时跳过协议握手，直接回收本代连接。 */
	abort(): Promise<void> {
		return this.startClose(false, 0);
	}

	private startClose(graceful: boolean, timeoutMs: number): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.stop();
		const pending = this.performClose(graceful, timeoutMs);
		this.closePromise = pending;
		return pending;
	}

	private async performClose(graceful: boolean, timeoutMs: number): Promise<void> {
		this.transport.beginClose();
		try {
			if (graceful) await this.performProtocolClose(timeoutMs);
		} finally {
			this.rpc.dispose();
			try {
				await this.transport.close();
			} finally {
				await settleUntil(this.writer.drain(), Date.now() + POST_CLOSE_DRAIN_MS);
			}
		}
	}

	private async performProtocolClose(timeoutMs: number): Promise<void> {
		const graceMs = Math.min(MAX_GRACEFUL_CLOSE_MS, Math.max(MIN_GRACEFUL_CLOSE_MS, timeoutMs));
		const deadline = Date.now() + graceMs;
		const shutdownDeadline = Math.min(deadline, Date.now() + Math.min(1000, Math.floor(graceMs / 2)));
		const shutdown = callDuringClose(() => this.rpc.sendRequest(ShutdownRequest.type, undefined));
		await settleUntil(shutdown, shutdownDeadline);

		const exit = callDuringClose(() => this.rpc.sendNotification(ExitNotification.type));
		const drained = await settleUntil(Promise.all([exit, this.writer.drain()]), deadline);
		if (drained) {
			try {
				this.rpc.end();
			} catch {
				// transport close 仍会完成强制回收。
			}
		}
		await settleUntil(this.transport.closed, deadline);
	}
}

/**
 * vscode-jsonrpc 的 sendRequest 会在 writer rejection 后额外抛出一次异常。
 * writer 在此吸收原始 stream rejection，并通过单次 failure signal 让 client 统一中止 connection。
 */
class DrainingMessageWriter implements MessageWriter {
	private pendingWrites = 0;
	private readonly drainWaiters = new Set<() => void>();

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

	async write(message: Message): Promise<void> {
		this.pendingWrites += 1;
		try {
			await this.inner.write(message);
		} catch (error) {
			this.onWriteError(error);
		} finally {
			this.pendingWrites -= 1;
			if (this.pendingWrites === 0) {
				for (const resolve of this.drainWaiters) resolve();
				this.drainWaiters.clear();
			}
		}
	}

	drain(): Promise<void> {
		if (this.pendingWrites === 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.drainWaiters.add(resolve);
		});
	}

	end(): void {
		this.inner.end();
	}

	dispose(): void {
		this.inner.dispose();
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

function callDuringClose<T>(factory: () => Promise<T>): Promise<T | undefined> {
	try {
		return factory().catch(() => undefined);
	} catch {
		return Promise.resolve(undefined);
	}
}

async function settleUntil(promise: Promise<unknown>, deadline: number): Promise<boolean> {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) {
		void promise.catch(() => undefined);
		return false;
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), remainingMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
