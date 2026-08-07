import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { userCachePath } from "../cache-path.js";

export const USER_HISTORY_LIMIT = 100;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_COMPACT_TARGET_BYTES = 6 * 1024 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export interface UserHistoryRecord {
	timestamp: string;
	cwd: string;
	session: string;
	text: string;
}

export interface UserHistoryAppend {
	cwd: string;
	session: string;
	text: string;
	timestamp?: Date;
}

export interface UserHistoryStoreOptions {
	filePath?: string;
	maxFileBytes?: number;
	compactTargetBytes?: number;
	maxEntriesPerPath?: number;
}

/** 单文件 JSONL 历史；追加和压缩在进程内串行，并用短期目录锁协调多个 Pi 进程。 */
export class UserHistoryStore {
	readonly filePath: string;
	private readonly maxFileBytes: number;
	private readonly compactTargetBytes: number;
	private readonly maxEntriesPerPath: number;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(options: UserHistoryStoreOptions = {}) {
		this.filePath = options.filePath ?? userCachePath("user-history", "history.jsonl");
		this.maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
		this.compactTargetBytes = Math.min(
			this.maxFileBytes,
			positiveInteger(options.compactTargetBytes, DEFAULT_COMPACT_TARGET_BYTES),
		);
		this.maxEntriesPerPath = positiveInteger(options.maxEntriesPerPath, USER_HISTORY_LIMIT);
	}

	async load(cwd: string, limit = USER_HISTORY_LIMIT): Promise<UserHistoryRecord[]> {
		const normalizedCwd = normalizeHistoryCwd(cwd);
		const count = Math.max(0, Math.floor(limit));
		if (count === 0) return [];
		return readRecentRecords(this.filePath, normalizedCwd, count);
	}

	append(entry: UserHistoryAppend): Promise<void> {
		const text = entry.text.trim();
		if (text.length === 0) return Promise.resolve();
		const record: UserHistoryRecord = {
			timestamp: (entry.timestamp ?? new Date()).toISOString(),
			cwd: normalizeHistoryCwd(entry.cwd),
			session: entry.session,
			text,
		};
		const operation = this.writeTail.then(() => this.appendRecord(record));
		this.writeTail = operation.catch(() => {});
		return operation;
	}

	async flush(): Promise<void> {
		await this.writeTail;
	}

	private async appendRecord(record: UserHistoryRecord): Promise<void> {
		const directory = path.dirname(this.filePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await withHistoryLock(this.filePath, async () => {
			await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
			const metadata = await stat(this.filePath);
			if (metadata.size > this.maxFileBytes) {
				await compactHistoryFile(
					this.filePath,
					this.compactTargetBytes,
					this.maxEntriesPerPath,
				);
			}
		});
	}
}

export interface SessionHistoryMessage {
	timestamp: number;
	text: string;
}

/** 补入功能启用前的当前会话消息，同时避免重复回放已记录的会话。 */
export function buildInitialHistory(
	records: readonly UserHistoryRecord[],
	sessionMessages: readonly SessionHistoryMessage[],
	sessionId: string,
	limit = USER_HISTORY_LIMIT,
): string[] {
	const indexed = records.map((record, index) => ({
		timestamp: Date.parse(record.timestamp),
		text: record.text,
		index,
	}));
	const currentSessionTimes = records
		.filter((record) => record.session === sessionId)
		.map((record) => Date.parse(record.timestamp));
	const earliestRecorded = currentSessionTimes.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...currentSessionTimes);
	let index = indexed.length;
	for (const message of sessionMessages) {
		const text = message.text.trim();
		if (text.length === 0 || message.timestamp >= earliestRecorded) continue;
		indexed.push({ timestamp: message.timestamp, text, index });
		index += 1;
	}
	indexed.sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);
	return indexed.slice(-Math.max(0, Math.floor(limit))).map((entry) => entry.text);
}

export function normalizeHistoryCwd(cwd: string): string {
	return path.resolve(cwd);
}

async function readRecentRecords(filePath: string, cwd: string, limit: number): Promise<UserHistoryRecord[]> {
	let handle;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return [];
		throw error;
	}
	try {
		const metadata = await handle.stat();
		let position = metadata.size;
		let suffix = Buffer.alloc(0);
		const newestFirst: UserHistoryRecord[] = [];
		while (position > 0 && newestFirst.length < limit) {
			const length = Math.min(READ_BLOCK_BYTES, position);
			const start = position - length;
			const chunk = Buffer.allocUnsafe(length);
			let bytesRead = 0;
			while (bytesRead < length) {
				const result = await handle.read(chunk, bytesRead, length - bytesRead, start + bytesRead);
				if (result.bytesRead === 0) break;
				bytesRead += result.bytesRead;
			}
			const completeChunk = bytesRead === length ? chunk : chunk.subarray(0, bytesRead);
			const data = suffix.length === 0 ? completeChunk : Buffer.concat([completeChunk, suffix]);
			let lineEnd = data.length;
			for (let cursor = data.length - 1; cursor >= 0 && newestFirst.length < limit; cursor -= 1) {
				if (data[cursor] !== 0x0a) continue;
				readMatchingLine(data.subarray(cursor + 1, lineEnd), cwd, newestFirst);
				lineEnd = cursor;
			}
			suffix = Buffer.from(data.subarray(0, lineEnd));
			position = start;
		}
		if (position === 0 && newestFirst.length < limit) readMatchingLine(suffix, cwd, newestFirst);
		return newestFirst.reverse();
	} finally {
		await handle.close();
	}
}

function readMatchingLine(line: Buffer, cwd: string, records: UserHistoryRecord[]): void {
	if (line.length === 0) return;
	const record = parseHistoryRecord(line.toString("utf8"));
	if (record !== undefined && normalizeHistoryCwd(record.cwd) === cwd) records.push(record);
}

function parseHistoryRecord(line: string): UserHistoryRecord | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) return undefined;
		const { timestamp, cwd, session, text } = value;
		if (
			typeof timestamp !== "string"
			|| !Number.isFinite(Date.parse(timestamp))
			|| typeof cwd !== "string"
			|| cwd.length === 0
			|| typeof session !== "string"
			|| session.length === 0
			|| typeof text !== "string"
			|| text.trim().length === 0
		) return undefined;
		return { timestamp, cwd, session, text: text.trim() };
	} catch {
		return undefined;
	}
}

async function compactHistoryFile(filePath: string, targetBytes: number, maxEntriesPerPath: number): Promise<void> {
	const content = await readFile(filePath, "utf8");
	const lines = content.split("\n");
	const retainedNewestFirst: string[] = [];
	const pathCounts = new Map<string, number>();
	let retainedBytes = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === undefined || line.length === 0) continue;
		const record = parseHistoryRecord(line);
		if (record === undefined) continue;
		const cwd = normalizeHistoryCwd(record.cwd);
		const count = pathCounts.get(cwd) ?? 0;
		if (count >= maxEntriesPerPath) continue;
		const normalizedLine = JSON.stringify({ ...record, cwd });
		const bytes = Buffer.byteLength(normalizedLine) + 1;
		if (retainedBytes > 0 && retainedBytes + bytes > targetBytes) continue;
		retainedNewestFirst.push(normalizedLine);
		pathCounts.set(cwd, count + 1);
		retainedBytes += bytes;
	}
	const output = retainedNewestFirst.reverse().join("\n");
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporaryPath, output.length === 0 ? "" : `${output}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => {});
	}
}

async function withHistoryLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${filePath}.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;
			if (await removeStaleLock(lockPath)) continue;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for user history lock: ${lockPath}`);
			await delay(LOCK_RETRY_MS);
		}
	}
	try {
		return await operation();
	} finally {
		await rm(lockPath, { recursive: true, force: true }).catch(() => {});
	}
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
	try {
		const metadata = await stat(lockPath);
		if (Date.now() - metadata.mtimeMs < STALE_LOCK_MS) return false;
		await rm(lockPath, { recursive: true, force: true });
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return true;
		throw error;
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
