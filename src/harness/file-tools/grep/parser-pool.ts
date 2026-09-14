import { analyzeCodeFile } from "../../code-index/parser.js";
import type { AnalyzedFileIndex } from "../../code-index/types.js";
import { DEFAULT_WORKER_CONCURRENCY } from "../../worker-runtime/concurrency.js";
import { createTypeScriptWorker } from "../../worker-runtime/typescript-worker.js";
import { WorkerTaskAbortedError, WorkerTaskPool, type WorkerTaskResponse } from "../../worker-runtime/worker-task-pool.js";

const GREP_CONCURRENCY = DEFAULT_WORKER_CONCURRENCY;
const GREP_PARSER_BATCH_SIZE = 32;

interface GrepParseWorkload {
	fileCount: number;
	totalBytes: number;
	maxFileBytes: number;
}

interface OffloadDecisionOptions {
	workerWarm?: boolean;
}

export interface GrepParseFile {
	readonly path: string;
	readonly text: string;
}
type GrepParserWorkerPool = WorkerTaskPool<GrepParseFile[], AnalyzedFileIndex[]>;

const MAIN_THREAD_MAX_PARSE_BYTES = 256 * 1024;
const LOCAL_FILE_COST_MS = 0.4;
const LOCAL_BYTES_PER_MS = 4_000;
const TRANSFER_FILE_COST_MS = 0.1;
const TRANSFER_BYTES_PER_MS = 100_000;
const COLD_WORKER_START_MS = 105;
const WARM_WORKER_START_MS = 3;

function shouldOffloadGrepParsing(workload: GrepParseWorkload, options: OffloadDecisionOptions = {}): boolean {
	if (workload.fileCount <= 0 || workload.totalBytes <= 0) return false;
	if (workload.maxFileBytes >= MAIN_THREAD_MAX_PARSE_BYTES) return true;
	const workers = Math.min(GREP_CONCURRENCY, Math.ceil(workload.fileCount / GREP_PARSER_BATCH_SIZE));
	if (workers <= 1) return false;
	const localMs = workload.fileCount * LOCAL_FILE_COST_MS + workload.totalBytes / LOCAL_BYTES_PER_MS;
	const transferMs = workload.fileCount * TRANSFER_FILE_COST_MS + workload.totalBytes / TRANSFER_BYTES_PER_MS;
	const startupMs = options.workerWarm === true ? WARM_WORKER_START_MS : COLD_WORKER_START_MS;
	return startupMs + localMs / workers + transferMs < localMs;
}

/** Grep-owned parser and worker pool. No process-global worker survives its owner. */
export class GrepParser {
	private pool: GrepParserWorkerPool | undefined;
	private disposed = false;

	async analyzeFiles(files: readonly GrepParseFile[], signal: AbortSignal | undefined): Promise<AnalyzedFileIndex[]> {
		if (this.disposed || signal?.aborted === true) throw new AbortGrepParse();
		const workload = parseWorkload(files);
		const offload = shouldOffloadGrepParsing(workload, { workerWarm: this.pool !== undefined });
		if (!offload) return await analyzeLocally(files, signal);
		try {
			this.pool ??= createGrepParserPool();
			const pool = this.pool;
			const batches = chunk(files, GREP_PARSER_BATCH_SIZE);
			return (await Promise.all(batches.map((batch) => pool.run(batch, signal)))).flat();
		} catch (error) {
			if (this.isDisposed() || isAborted(signal) || error instanceof AbortGrepParse || error instanceof WorkerTaskAbortedError) {
				throw new AbortGrepParse();
			}
			throw error;
		}
	}

	private isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pool?.dispose();
		this.pool = undefined;
	}
}

export class AbortGrepParse extends Error {}

async function analyzeLocally(files: readonly GrepParseFile[], signal?: AbortSignal): Promise<AnalyzedFileIndex[]> {
	const result: AnalyzedFileIndex[] = [];
	try {
		for (const file of files) {
			if (signal?.aborted === true) throw new AbortGrepParse();
			result.push(await analyzeCodeFile(file.path, file.text, signal));
		}
		return result;
	} catch (error) {
		if (signal?.aborted === true) throw new AbortGrepParse();
		throw error;
	}
}

function createGrepParserPool(): GrepParserWorkerPool {
	return new WorkerTaskPool<GrepParseFile[], AnalyzedFileIndex[]>({
		workerLimit: GREP_CONCURRENCY,
		createWorker: () => createTypeScriptWorker(new URL("./parser-worker.ts", import.meta.url)),
		workerName: "grep parser",
		requestForTask: (id, files) => ({ id, files }),
		decodeResponse: decodeGrepParserResponse,
	});
}

function decodeGrepParserResponse(message: unknown): WorkerTaskResponse<AnalyzedFileIndex[]> | undefined {
	if (!isRecord(message) || typeof message.id !== "number") return undefined;
	if (Array.isArray(message.results)) return { id: message.id, result: message.results as AnalyzedFileIndex[] };
	return typeof message.error === "string" ? { id: message.id, error: message.error } : undefined;
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseWorkload(files: readonly GrepParseFile[]): GrepParseWorkload {
	let totalBytes = 0;
	let maxFileBytes = 0;
	for (const file of files) {
		const bytes = Buffer.byteLength(file.text);
		totalBytes += bytes;
		maxFileBytes = Math.max(maxFileBytes, bytes);
	}
	return { fileCount: files.length, totalBytes, maxFileBytes };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}
