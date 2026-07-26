import { analyzeCodeFile, analyzeTextFile, type AnalyzedFileIndex } from "../../code-index/parser.js";
import { DEFAULT_WORKER_CONCURRENCY } from "../../worker-runtime/concurrency.js";
import { createTypeScriptWorker } from "../../worker-runtime/typescript-worker.js";
import { WorkerTaskAbortedError, WorkerTaskPool, type WorkerTaskResponse } from "../../worker-runtime/worker-task-pool.js";

export const GREP_CONCURRENCY = DEFAULT_WORKER_CONCURRENCY;
export const GREP_PARSER_BATCH_SIZE = 32;

export interface GrepParseWorkload {
	fileCount: number;
	totalBytes: number;
	maxFileBytes: number;
}

export interface OffloadDecisionOptions {
	concurrency?: number;
	workerWarm?: boolean;
}

type GrepParseFile = { path: string; text: string; syntax: boolean };
type GrepParserWorkerPool = WorkerTaskPool<GrepParseFile[], AnalyzedFileIndex[]>;

const MAIN_THREAD_MAX_PARSE_BYTES = 256 * 1024;
const LOCAL_FILE_COST_MS = 0.4;
const LOCAL_BYTES_PER_MS = 4_000;
const TRANSFER_FILE_COST_MS = 0.1;
const TRANSFER_BYTES_PER_MS = 100_000;
const COLD_WORKER_START_MS = 105;
const WARM_WORKER_START_MS = 3;

export function shouldOffloadGrepParsing(workload: GrepParseWorkload, options: OffloadDecisionOptions = {}): boolean {
	if (workload.fileCount <= 0 || workload.totalBytes <= 0) return false;
	if (workload.maxFileBytes >= MAIN_THREAD_MAX_PARSE_BYTES) return true;
	const concurrency = Math.max(1, options.concurrency ?? GREP_CONCURRENCY);
	const workers = Math.min(concurrency, Math.ceil(workload.fileCount / GREP_PARSER_BATCH_SIZE));
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

	shouldOffload(workload: GrepParseWorkload): boolean {
		return shouldOffloadGrepParsing(workload, { workerWarm: this.pool !== undefined });
	}

	async analyzeFile(filePath: string, text: string, signal: AbortSignal | undefined, offload: boolean, syntax = true): Promise<AnalyzedFileIndex> {
		return (await this.analyzeFiles([{ path: filePath, text, syntax }], signal, offload))[0]
			?? await analyzeRequestedFile({ path: filePath, text, syntax }, signal);
	}

	async analyzeFiles(files: GrepParseFile[], signal: AbortSignal | undefined, offload: boolean): Promise<AnalyzedFileIndex[]> {
		if (this.disposed || signal?.aborted === true) throw new AbortGrepParse();
		if (!offload) return await analyzeLocally(files, signal);
		const syntaxFiles = files.filter((file) => file.syntax);
		if (syntaxFiles.length === 0) return await analyzeLocally(files, signal);
		try {
			this.pool ??= createGrepParserPool();
			const pool = this.pool;
			const batches = chunk(syntaxFiles, GREP_PARSER_BATCH_SIZE);
			const syntaxResults = (await Promise.all(batches.map(async (batch) => await pool.run(batch, signal)))).flat();
			let syntaxIndex = 0;
			return await Promise.all(files.map(async (file) => {
				if (!file.syntax) return analyzeTextFile(file.path);
				const result = syntaxResults[syntaxIndex];
				syntaxIndex += 1;
				return result ?? await analyzeRequestedFile(file, signal);
			}));
		} catch (error) {
			if (this.isDisposed() || isAborted(signal) || error instanceof AbortGrepParse || error instanceof WorkerTaskAbortedError) {
				throw new AbortGrepParse();
			}
			return await analyzeLocally(files, signal);
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

async function analyzeLocally(files: GrepParseFile[], signal?: AbortSignal): Promise<AnalyzedFileIndex[]> {
	try {
		return await Promise.all(files.map(async (file) => await analyzeRequestedFile(file, signal)));
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

function chunk<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

async function analyzeRequestedFile(file: GrepParseFile, signal?: AbortSignal): Promise<AnalyzedFileIndex> {
	return file.syntax ? await analyzeCodeFile(file.path, file.text, { ...(signal === undefined ? {} : { signal }) }) : analyzeTextFile(file.path);
}
