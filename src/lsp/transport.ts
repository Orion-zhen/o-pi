import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net, { type Socket } from "node:net";

import type { LspTransport } from "./types.js";

const STDERR_TAIL_BYTES = 8192;

/** 已建立的 LSP 字节流连接及其底层资源。 */
export interface LspTransportConnection {
	readonly reader: NodeJS.ReadableStream;
	readonly writer: NodeJS.WritableStream;
	/** 连接异常时 reject；主动 close 不会触发该 promise。 */
	readonly failure: Promise<never>;
	/** stdio server 最近的有界 stderr；TCP transport 返回 undefined。 */
	stderrTail(): string | undefined;
	close(): Promise<void>;
}

/** 根据规范化配置建立 stdio 或 TCP LSP 连接。 */
export async function connectLspTransport(transport: LspTransport, root: string, timeoutMs: number): Promise<LspTransportConnection> {
	return transport.type === "stdio"
		? connectStdio(transport.command, transport.args, root)
		: connectTcp(transport.host, transport.port, timeoutMs);
}

async function connectStdio(command: string, args: readonly string[], cwd: string): Promise<LspTransportConnection> {
	const child = spawn(command, [...args], { cwd, stdio: "pipe" });
	let closing = false;
	let failed = false;
	let stderrTail = Buffer.alloc(0);
	let rejectFailure: (error: Error) => void = () => undefined;
	const failure = new Promise<never>((_resolve, reject) => {
		rejectFailure = reject;
	});
	void failure.catch(() => undefined);
	const stderrText = (): string | undefined => {
		const value = stderrTail.toString("utf8").trim();
		return value.length === 0 ? undefined : value;
	};
	const fail = (error: unknown): void => {
		if (closing || failed) return;
		failed = true;
		const message = toError(error).message;
		const stderr = stderrText();
		rejectFailure(new Error(stderr === undefined ? message : `${message}; stderr: ${stderr}`));
	};
	child.stderr.on("data", (chunk: Buffer | string) => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		stderrTail = Buffer.concat([stderrTail, bytes]).subarray(-STDERR_TAIL_BYTES);
	});
	child.on("error", fail);
	child.stdin.on("error", fail);
	child.stdout.on("error", fail);
	child.stderr.on("error", fail);
	child.once("exit", (code, signal) => {
		fail(`server exited${code === null ? "" : ` ${code}`}${signal === null ? "" : ` ${signal}`}`);
	});
	if (child.pid === undefined) {
		closing = true;
		await terminateChild(child);
		throw new Error(`server failed to start: ${command}`);
	}

	return {
		reader: child.stdout,
		writer: child.stdin,
		failure,
		stderrTail: stderrText,
		close: async () => {
			closing = true;
			await terminateChild(child);
		},
	};
}

async function connectTcp(host: string, port: number, timeoutMs: number): Promise<LspTransportConnection> {
	const socket = net.createConnection({ host, port });
	try {
		await withTimeout(waitForSocket(socket), timeoutMs);
	} catch (error) {
		socket.destroy();
		throw error;
	}

	let closing = false;
	let failed = false;
	let rejectFailure: (error: Error) => void = () => undefined;
	const failure = new Promise<never>((_resolve, reject) => {
		rejectFailure = reject;
	});
	void failure.catch(() => undefined);
	const fail = (error: unknown): void => {
		if (closing || failed) return;
		failed = true;
		rejectFailure(toError(error));
	};
	socket.on("error", fail);
	socket.on("close", () => fail("connection closed"));

	return {
		reader: socket,
		writer: socket,
		failure,
		stderrTail: () => undefined,
		close: () => closeSocket(socket, () => { closing = true; }),
	};
}

function waitForSocket(socket: Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		const onConnect = (): void => {
			socket.off("error", onError);
			resolve();
		};
		const onError = (error: Error): void => {
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

async function closeSocket(socket: Socket, markClosing: () => void): Promise<void> {
	markClosing();
	if (socket.destroyed) return;
	await new Promise<void>((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const finish = (): void => {
			socket.off("close", finish);
			if (timer !== undefined) clearTimeout(timer);
			resolve();
		};
		socket.once("close", finish);
		timer = setTimeout(() => {
			socket.destroy();
			finish();
		}, 1000);
		socket.end();
	});
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (hasExited(child)) return;
	if (!child.killed) child.kill("SIGTERM");
	if (await waitForChildExit(child, 1000)) return;
	child.kill("SIGKILL");
	await waitForChildExit(child, 1000);
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (hasExited(child)) return true;
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const onExit = (): void => finish(true);
		const finish = (exited: boolean): void => {
			child.off("exit", onExit);
			if (timer !== undefined) clearTimeout(timer);
			resolve(exited);
		};
		child.once("exit", onExit);
		timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
	});
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
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

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
