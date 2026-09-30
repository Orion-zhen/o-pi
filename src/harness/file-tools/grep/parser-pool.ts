import { analyzeCodeFile } from "../../code-index/parser.ts";
import type { AnalyzedFileIndex } from "../../code-index/types.ts";
import { DEFAULT_WORKER_CONCURRENCY } from "../../worker-runtime/concurrency.ts";
import { createTypeScriptWorker } from "../../worker-runtime/typescript-worker.ts";
import { WorkerTaskAbortedError, WorkerTaskPool } from "../../worker-runtime/worker-task-pool.ts";

const GREP_CONCURRENCY = DEFAULT_WORKER_CONCURRENCY;
const GREP_PARSER_BATCH_SIZE = 32;

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

function shouldOffloadGrepParsing(files: readonly GrepParseFile[], workerWarm: boolean): boolean {
	let totalBytes = 0;
	for (const file of files) {
		const bytes = Buffer.byteLength(file.text);
		if (bytes >= MAIN_THREAD_MAX_PARSE_BYTES) return true;
		totalBytes += bytes;
	}
	if (totalBytes === 0) return false;
	const workers = Math.min(GREP_CONCURRENCY, Math.ceil(files.length / GREP_PARSER_BATCH_SIZE));
	if (workers <= 1) return false;
	const localMs = files.length * LOCAL_FILE_COST_MS + totalBytes / LOCAL_BYTES_PER_MS;
	const transferMs = files.length * TRANSFER_FILE_COST_MS + totalBytes / TRANSFER_BYTES_PER_MS;
	const startupMs = workerWarm ? WARM_WORKER_START_MS : COLD_WORKER_START_MS;
	return startupMs + localMs / workers + transferMs < localMs;
}

/** Grep-owned parser and worker pool. No process-global worker survives its owner. */
export class GrepParser {
	private pool: GrepParserWorkerPool | undefined;
	private disposed = false;

	async analyzeFiles(files: readonly GrepParseFile[], signal: AbortSignal | undefined): Promise<AnalyzedFileIndex[]> {
		if (this.disposed || signal?.aborted === true) throw new AbortGrepParse();
		if (!shouldOffloadGrepParsing(files, this.pool !== undefined)) return await analyzeLocally(files, signal);
		try {
			this.pool ??= new WorkerTaskPool({
				workerLimit: GREP_CONCURRENCY,
				createWorker: () => createTypeScriptWorker(new URL("./parser-worker.ts", import.meta.url)),
				workerName: "grep parser",
			});
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

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}
