import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type Message,
	type MessageConnection,
	type MessageWriter,
} from "vscode-jsonrpc/node";
import { ExitNotification, ShutdownRequest } from "vscode-languageserver-protocol";

import type { LspTransportConnection } from "../protocol/transport.js";

const MIN_GRACEFUL_CLOSE_MS = 1000;
const MAX_GRACEFUL_CLOSE_MS = 3000;
const POST_CLOSE_DRAIN_MS = 1000;

/** 一代 LSP 协议连接；独占 JSON-RPC writer、connection 和底层 transport。 */
export class LspClientConnection {
	readonly rpc: MessageConnection;
	private readonly writer: DrainingMessageWriter;
	private closePromise: Promise<void> | undefined;

	constructor(
		private readonly transport: LspTransportConnection,
		onWriteError: (error: unknown) => void,
	) {
		this.writer = new DrainingMessageWriter(new StreamMessageWriter(transport.writer), onWriteError);
		this.rpc = createMessageConnection(new StreamMessageReader(transport.reader), this.writer);
	}

	get failure(): Promise<never> {
		return this.transport.failure;
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
	private failureReported = false;
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
			if (!this.failureReported) {
				this.failureReported = true;
				try {
					this.onWriteError(error);
				} catch {
					// failure callback 不能重新暴露被吸收的 writer rejection。
				}
			}
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
