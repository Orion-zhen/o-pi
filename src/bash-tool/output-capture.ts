import type { WriteStream } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import type { CapturedOutput, CapturedPreview } from "./types.js";
import { decodeUtf8Prefix, takeTailBytes, trimLeadingUtf8Continuation } from "./utf8.js";

interface CaptureOptions {
	sessionId: string;
	toolCallId: string;
	maxCaptureBytes: number;
	previewBytes: number;
}

/** 从第一字节开始落盘，内存中只保留固定大小的原始头尾窗口。 */
export class OutputCapture {
	private readonly head: Buffer;
	private readonly tail: Buffer;
	private readonly completion: Promise<{ error: unknown } | undefined>;
	private totalBytes = 0;
	private capturedBytes = 0;
	private lineBreaks = 0;
	private lastByteWasNewline = false;
	private headLength = 0;
	private tailLength = 0;
	private tailWriteOffset = 0;
	private binary = false;

	private constructor(
		private readonly logPath: string,
		private readonly stream: WriteStream,
		private readonly maxCaptureBytes: number,
		previewBytes: number,
	) {
		const headLimit = Math.floor(previewBytes / 2);
		this.head = Buffer.alloc(headLimit);
		this.tail = Buffer.alloc(previewBytes - headLimit);
		// 立即监听写入错误，并将拒绝转为可等待的结果，避免 finish 之前发生未处理异常。
		this.completion = finished(stream, { cleanup: true }).then(
			() => undefined,
			(error: unknown) => ({ error }),
		);
	}

	static async create(options: CaptureOptions): Promise<OutputCapture> {
		const dir = path.join(os.tmpdir(), "o-pi", "bash", sanitizePathPart(options.sessionId));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmodForPlatform(dir, 0o700);
		const logPath = path.join(dir, `${sanitizePathPart(options.toolCallId)}.log`);
		const file = await open(logPath, "w", 0o600);
		try {
			await chmodForPlatform(logPath, 0o600);
			return new OutputCapture(logPath, file.createWriteStream(), options.maxCaptureBytes, options.previewBytes);
		} catch (error) {
			await file.close().catch(() => undefined);
			await rm(logPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	append(data: Buffer): void {
		if (data.byteLength === 0) return;
		this.totalBytes += data.byteLength;
		for (const byte of data) {
			if (byte === 0x0a) this.lineBreaks += 1;
			else if (byte === 0x00) this.binary = true;
		}
		this.lastByteWasNewline = data[data.byteLength - 1] === 0x0a;

		if (!this.stream.destroyed && this.capturedBytes < this.maxCaptureBytes) {
			const remaining = this.maxCaptureBytes - this.capturedBytes;
			const chunk = data.byteLength <= remaining ? data : data.subarray(0, remaining);
			this.stream.write(chunk);
			this.capturedBytes += chunk.byteLength;
		}
		this.appendHead(data);
		this.appendTail(data);
	}

	liveText(maxBytes: number): string {
		const tail = this.orderedTail();
		const bytes = this.totalBytes <= tail.byteLength ? tail : trimLeadingUtf8Continuation(tail);
		return takeTailBytes(decodeUtf8Prefix(bytes), maxBytes);
	}

	async finish(): Promise<CapturedOutput> {
		this.stream.end();
		const failure = await this.completion;
		if (failure !== undefined) throw failure.error;
		return {
			preview: this.preview(),
			totalBytes: this.totalBytes,
			totalLines: this.totalBytes === 0 ? 0 : this.lineBreaks + (this.lastByteWasNewline ? 0 : 1),
			logPath: this.logPath,
			captureComplete: this.capturedBytes === this.totalBytes,
			binary: this.binary,
		};
	}

	/** 异常路径先释放文件流，再删除日志。调用方决定是否保留原始异常。 */
	async discard(): Promise<void> {
		this.stream.destroy();
		await this.completion;
		await this.deleteLog();
	}

	async deleteLog(): Promise<void> {
		await rm(this.logPath, { force: true });
	}

	private appendHead(data: Buffer): void {
		const copied = Math.min(this.head.byteLength - this.headLength, data.byteLength);
		data.copy(this.head, this.headLength, 0, copied);
		this.headLength += copied;
	}

	private appendTail(data: Buffer): void {
		const capacity = this.tail.byteLength;
		if (data.byteLength >= capacity) {
			data.copy(this.tail, 0, data.byteLength - capacity);
			this.tailLength = capacity;
			this.tailWriteOffset = 0;
			return;
		}
		const firstLength = Math.min(data.byteLength, capacity - this.tailWriteOffset);
		data.copy(this.tail, this.tailWriteOffset, 0, firstLength);
		if (firstLength < data.byteLength) data.copy(this.tail, 0, firstLength);
		this.tailWriteOffset = (this.tailWriteOffset + data.byteLength) % capacity;
		this.tailLength = Math.min(capacity, this.tailLength + data.byteLength);
	}

	private orderedTail(): Buffer {
		if (this.tailLength < this.tail.byteLength) return this.tail.subarray(0, this.tailLength);
		if (this.tailWriteOffset === 0) return this.tail;
		return Buffer.concat([this.tail.subarray(this.tailWriteOffset), this.tail.subarray(0, this.tailWriteOffset)]);
	}

	private preview(): CapturedPreview {
		const head = this.head.subarray(0, this.headLength);
		const tail = this.orderedTail();
		const omittedBytes = this.totalBytes - head.byteLength - tail.byteLength;
		if (omittedBytes > 0) return { kind: "split", head, tail, omittedBytes };
		return { kind: "complete", bytes: Buffer.concat([head, tail.subarray(-omittedBytes)]) };
	}
}

function sanitizePathPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized.length > 0 ? sanitized.slice(0, 96) : "unknown";
}

async function chmodForPlatform(target: string, mode: number): Promise<void> {
	if (process.platform !== "win32") {
		await chmod(target, mode);
		return;
	}
	try {
		await chmod(target, mode);
	} catch {
		// Windows 不提供完整 POSIX mode 语义，创建时的 mode 仍作为权限提示。
	}
}
