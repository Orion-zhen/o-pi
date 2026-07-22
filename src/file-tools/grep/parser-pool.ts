import type { Worker } from "node:worker_threads";

import { analyzeCodeFile, analyzeTextFile, type AnalyzedFileIndex } from "../../code-index/parser.js";
import { FILE_SEARCH_CONCURRENCY } from "../core/search-concurrency.js";
import { createTypeScriptWorker } from "../core/typescript-worker.js";

interface ParseTask {
	id: number;
	files: Array<{ path: string; text: string; syntax: boolean }>;
	resolve(result: AnalyzedFileIndex[]): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
	settled: boolean;
}

interface ParseWorkerResponse {
	id: number;
	results?: AnalyzedFileIndex[];
	error?: string;
}

interface WorkerSlot {
	worker: Worker;
	task?: ParseTask;
	stopping: boolean;
}

/** grep 的默认并发路数：逻辑核心数的一半，单核环境至少保留一路。 */
export const GREP_CONCURRENCY = FILE_SEARCH_CONCURRENCY;

export interface GrepParseWorkload {
	fileCount: number;
	totalBytes: number;
	maxFileBytes: number;
}

export interface OffloadDecisionOptions {
	concurrency?: number;
	workerWarm?: boolean;
}

export const GREP_PARSER_BATCH_SIZE = 32;
const MAIN_THREAD_MAX_PARSE_BYTES = 256 * 1024;
const LOCAL_FILE_COST_MS = 0.4;
const LOCAL_BYTES_PER_MS = 4_000;
const TRANSFER_FILE_COST_MS = 0.1;
const TRANSFER_BYTES_PER_MS = 100_000;
const COLD_WORKER_START_MS = 105;
const WARM_WORKER_START_MS = 3;

let sharedPool: GrepParserPool | undefined;

/** 依据真实解析工作量估算本地与 worker 墙钟成本；大单文件优先保护主事件循环。 */
export function shouldOffloadGrepParsing(workload: GrepParseWorkload, options: OffloadDecisionOptions = {}): boolean {
	if (workload.fileCount <= 0 || workload.totalBytes <= 0) return false;
	if (workload.maxFileBytes >= MAIN_THREAD_MAX_PARSE_BYTES) return true;
	const concurrency = Math.max(1, options.concurrency ?? GREP_CONCURRENCY);
	const workers = Math.min(concurrency, Math.ceil(workload.fileCount / GREP_PARSER_BATCH_SIZE));
	if (workers <= 1) return false;
	const localMs = workload.fileCount * LOCAL_FILE_COST_MS + workload.totalBytes / LOCAL_BYTES_PER_MS;
	const transferMs = workload.fileCount * TRANSFER_FILE_COST_MS + workload.totalBytes / TRANSFER_BYTES_PER_MS;
	const startupMs = (options.workerWarm ?? sharedPool?.isWarm() === true) ? WARM_WORKER_START_MS : COLD_WORKER_START_MS;
	return startupMs + localMs / workers + transferMs < localMs;
}

/** 大批量 grep 解析移到 worker；worker 不可用时退回同一份本地 parser，结果语义不变。 */
export async function analyzeGrepFile(
	filePath: string,
	text: string,
	signal: AbortSignal | undefined,
	offload: boolean,
	syntax = true,
): Promise<AnalyzedFileIndex> {
	return (await analyzeGrepFiles([{ path: filePath, text, syntax }], signal, offload))[0] ?? analyzeRequestedFile({ path: filePath, text, syntax });
}

export async function analyzeGrepFiles(
	files: Array<{ path: string; text: string; syntax: boolean }>,
	signal: AbortSignal | undefined,
	offload: boolean,
): Promise<AnalyzedFileIndex[]> {
	if (!offload) return files.map(analyzeRequestedFile);
	if (signal?.aborted) throw new AbortGrepParse();
	const syntaxFiles = files.filter((file) => file.syntax);
	if (syntaxFiles.length === 0) return files.map(analyzeRequestedFile);
	try {
		sharedPool ??= new GrepParserPool(GREP_CONCURRENCY);
		const syntaxResults = await sharedPool.run(syntaxFiles, signal);
		let syntaxIndex = 0;
		return files.map((file) => {
			if (!file.syntax) return analyzeTextFile(file.path);
			const result = syntaxResults[syntaxIndex];
			syntaxIndex += 1;
			return result ?? analyzeRequestedFile(file);
		});
	} catch (error) {
		if (error instanceof AbortGrepParse) throw error;
		return files.map(analyzeRequestedFile);
	}
}

export function clearGrepParserPool(): void {
	sharedPool?.dispose();
	sharedPool = undefined;
}

export class AbortGrepParse extends Error {}

class GrepParserPool {
	private readonly queue: ParseTask[] = [];
	private readonly slots = new Set<WorkerSlot>();
	private nextTaskId = 1;
	private disposed = false;

	constructor(private readonly workerLimit: number) {}

	isWarm(): boolean {
		return this.slots.size > 0;
	}

	run(files: Array<{ path: string; text: string; syntax: boolean }>, signal: AbortSignal | undefined): Promise<AnalyzedFileIndex[]> {
		if (this.disposed) return Promise.reject(new Error("grep parser pool is disposed"));
		return new Promise((resolve, reject) => {
			const task: ParseTask = {
				id: this.nextTaskId,
				files,
				resolve,
				reject,
				...(signal !== undefined ? { signal } : {}),
				settled: false,
			};
			this.nextTaskId += 1;
			if (signal?.aborted) {
				task.settled = true;
				reject(new AbortGrepParse());
				return;
			}
			if (signal !== undefined) {
				task.onAbort = () => this.abortTask(task);
				signal.addEventListener("abort", task.onAbort, { once: true });
			}
			this.queue.push(task);
			this.dispatch();
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const task of this.queue.splice(0)) this.rejectTask(task, new AbortGrepParse());
		for (const slot of this.slots) {
			if (slot.task !== undefined) this.rejectTask(slot.task, new AbortGrepParse());
			slot.stopping = true;
			void slot.worker.terminate();
		}
		this.slots.clear();
	}

	private dispatch(): void {
		if (this.disposed) return;
		let idleWorkers = Array.from(this.slots).filter((slot) => slot.task === undefined && !slot.stopping).length;
		while (this.slots.size < this.workerLimit && idleWorkers < this.queue.length) {
			this.spawnWorker();
			idleWorkers += 1;
		}
		for (const slot of this.slots) {
			if (slot.task !== undefined || slot.stopping) continue;
			const task = this.nextQueuedTask();
			if (task === undefined) return;
			slot.task = task;
			slot.worker.ref();
			slot.worker.postMessage({ id: task.id, files: task.files });
		}
	}

	private spawnWorker(): void {
		const worker = createTypeScriptWorker(new URL("./parser-worker.ts", import.meta.url));
		const slot: WorkerSlot = { worker, stopping: false };
		this.slots.add(slot);
		worker.on("message", (response: ParseWorkerResponse) => this.finishTask(slot, response));
		worker.on("error", (error) => this.failWorker(slot, error instanceof Error ? error : new Error(String(error))));
		worker.on("exit", (code) => {
			if (!slot.stopping && code !== 0) this.failWorker(slot, new Error(`grep parser worker exited with code ${code}`));
		});
		worker.unref();
	}

	private nextQueuedTask(): ParseTask | undefined {
		while (this.queue.length > 0) {
			const task = this.queue.shift();
			if (task !== undefined && !task.settled) return task;
		}
		return undefined;
	}

	private finishTask(slot: WorkerSlot, response: ParseWorkerResponse): void {
		const task = slot.task;
		if (task === undefined || response.id !== task.id) {
			this.failWorker(slot, new Error("grep parser worker returned an unexpected task"));
			return;
		}
		delete slot.task;
		slot.worker.unref();
		if (response.results !== undefined) this.resolveTask(task, response.results);
		else this.rejectTask(task, new Error(response.error ?? "grep parser worker failed"));
		this.dispatch();
	}

	private failWorker(slot: WorkerSlot, error: Error): void {
		if (!this.slots.delete(slot)) return;
		slot.stopping = true;
		void slot.worker.terminate();
		if (slot.task !== undefined) this.rejectTask(slot.task, error);
		this.dispatch();
	}

	private abortTask(task: ParseTask): void {
		if (task.settled) return;
		const queuedIndex = this.queue.indexOf(task);
		if (queuedIndex >= 0) {
			this.queue.splice(queuedIndex, 1);
			this.rejectTask(task, new AbortGrepParse());
			return;
		}
		const slot = Array.from(this.slots).find((candidate) => candidate.task === task);
		if (slot !== undefined) {
			this.slots.delete(slot);
			slot.stopping = true;
			delete slot.task;
			this.rejectTask(task, new AbortGrepParse());
			void slot.worker.terminate();
			this.dispatch();
		}
	}

	private resolveTask(task: ParseTask, result: AnalyzedFileIndex[]): void {
		if (task.settled) return;
		task.settled = true;
		this.removeAbortListener(task);
		task.resolve(result);
	}

	private rejectTask(task: ParseTask, error: Error): void {
		if (task.settled) return;
		task.settled = true;
		this.removeAbortListener(task);
		task.reject(error);
	}

	private removeAbortListener(task: ParseTask): void {
		if (task.signal !== undefined && task.onAbort !== undefined) task.signal.removeEventListener("abort", task.onAbort);
		delete task.onAbort;
	}
}

function analyzeRequestedFile(file: { path: string; text: string; syntax: boolean }): AnalyzedFileIndex {
	return file.syntax ? analyzeCodeFile(file.path, file.text) : analyzeTextFile(file.path);
}
