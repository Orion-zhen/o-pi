import type { WriteStream } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { CapturedOutput } from "./types.js";

interface CaptureOptions {
	sessionId: string;
	toolCallId: string;
	maxCaptureBytes: number;
	previewBytes: number;
}

/** 从第一字节开始落盘，同时只保留固定大小的 UTF-8 预览窗口。 */
export class OutputCapture {
	private readonly logPath: string;
	private readonly stream: WriteStream;
	private readonly previewLimit: number;
	private readonly head: Buffer;
	private readonly tail: Buffer;
	private totalBytes = 0;
	private capturedBytes = 0;
	private lineBreaks = 0;
	private lastByteWasNewline = false;
	private headLength = 0;
	private tailLength = 0;
	private tailWriteOffset = 0;
	private binary = false;
	private closed = false;

	private constructor(logPath: string, stream: WriteStream, private readonly maxCaptureBytes: number, previewBytes: number) {
		this.logPath = logPath;
		this.stream = stream;
		this.previewLimit = previewBytes;
		const headLimit = Math.floor(this.previewLimit / 2);
		this.head = Buffer.alloc(headLimit);
		this.tail = Buffer.alloc(this.previewLimit - headLimit);
	}

	static async create(options: CaptureOptions): Promise<OutputCapture> {
		const dir = path.join(os.tmpdir(), "o-pi", "bash", sanitizePathPart(options.sessionId));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmodBestEffort(dir, 0o700);
		const logPath = path.join(dir, `${sanitizePathPart(options.toolCallId)}.log`);
		const file = await open(logPath, "w", 0o600);
		try {
			await chmodBestEffort(logPath, 0o600);
			return new OutputCapture(logPath, file.createWriteStream(), options.maxCaptureBytes, options.previewBytes);
		} catch (error) {
			await file.close().catch(() => undefined);
			await rm(logPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	append(data: Buffer): void {
		if (this.closed || data.byteLength === 0) return;
		this.totalBytes += data.byteLength;
		for (let index = 0; index < data.byteLength; index += 1) {
			const byte = data[index];
			if (byte === 0x0a) this.lineBreaks += 1;
			else if (byte === 0x00) this.binary = true;
		}
		this.lastByteWasNewline = data[data.byteLength - 1] === 0x0a;

		if (this.capturedBytes < this.maxCaptureBytes) {
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
		const complete = this.totalBytes <= tail.byteLength;
		const decodable = complete ? tail : trimLeadingUtf8Continuation(tail);
		return takeTailBytes(decodeUtf8(decodable, this.closed), maxBytes);
	}

	async finish(): Promise<CapturedOutput> {
		if (this.closed) throw new Error("OutputCapture already closed.");
		this.closed = true;
		await new Promise<void>((resolve, reject) => {
			this.stream.end(() => resolve());
			this.stream.on("error", reject);
		});
		return {
			previewText: this.previewText(),
			totalBytes: this.totalBytes,
			totalLines: this.totalBytes === 0 ? 0 : this.lineBreaks + (this.lastByteWasNewline ? 0 : 1),
			logPath: this.logPath,
			captureComplete: this.capturedBytes === this.totalBytes,
			binary: this.binary,
		};
	}

	async deleteLog(): Promise<void> {
		await rm(this.logPath, { force: true });
	}

	private appendHead(data: Buffer): void {
		const remaining = this.head.byteLength - this.headLength;
		if (remaining <= 0) return;
		const copied = Math.min(remaining, data.byteLength);
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
		return Buffer.concat([
			this.tail.subarray(this.tailWriteOffset),
			this.tail.subarray(0, this.tailWriteOffset),
		], this.tailLength);
	}

	private previewText(): string {
		const head = this.head.subarray(0, this.headLength);
		const tail = this.orderedTail();
		if (this.totalBytes <= head.byteLength + tail.byteLength) {
			const tailStart = this.totalBytes - tail.byteLength;
			const overlap = Math.max(0, head.byteLength - tailStart);
			const bytes = overlap >= tail.byteLength ? head : Buffer.concat([head, tail.subarray(overlap)]);
			return boundedPreview(decodeUtf8(bytes, true), this.previewLimit);
		}

		const headText = takeHeadBytes(decodeUtf8(head, false), head.byteLength);
		const tailText = takeTailBytes(decodeUtf8(trimLeadingUtf8Continuation(tail), true), tail.byteLength);
		return headText + tailText;
	}
}

export function sanitizePathPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized.length > 0 ? sanitized.slice(0, 96) : "unknown";
}

export function takeHeadBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && isUtf8Continuation(bytes[end])) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

export function takeTailBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && isUtf8Continuation(bytes[start])) start += 1;
	return bytes.subarray(start).toString("utf8");
}

function boundedPreview(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const headLimit = Math.floor(maxBytes / 2);
	return takeHeadBytes(text, headLimit) + takeTailBytes(text, maxBytes - headLimit);
}

function trimLeadingUtf8Continuation(bytes: Buffer): Buffer {
	let start = 0;
	while (start < bytes.byteLength && isUtf8Continuation(bytes[start])) start += 1;
	return bytes.subarray(start);
}

function isUtf8Continuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

function decodeUtf8(bytes: Buffer, final: boolean): string {
	const decoder = new StringDecoder("utf8");
	const text = decoder.write(bytes);
	return final ? text + decoder.end() : text;
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
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
