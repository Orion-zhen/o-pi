import { Worker } from "node:worker_threads";

import type { FindEntry } from "../types.js";
import { FILE_SEARCH_CONCURRENCY } from "../core/search-concurrency.js";
import { rankFindMatches, rankFindSuggestions, type RankedFindEntries } from "./ranker.js";

interface SuggestionTask {
	id: number;
	entries: Array<Pick<FindEntry, "path" | "kind">>;
	query: string;
	rootPath: string;
	resolve(paths: string[]): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
	settled: boolean;
}

interface SuggestionWorkerResponse {
	id: number;
	paths?: string[];
	error?: string;
}

interface WorkerSlot {
	worker: Worker;
	task?: SuggestionTask;
	stopping: boolean;
}

export interface FindSuggestionDecisionOptions {
	concurrency?: number;
	workerWarm?: boolean;
}

export const FIND_CONCURRENCY = FILE_SEARCH_CONCURRENCY;
export const FIND_SUGGESTION_CHUNK_SIZE = 4_096;
const FUSE_FIELDS = 6;
const LOCAL_WORK_UNITS_PER_MS = 170;
const TRANSFER_ENTRIES_PER_MS = 80;
const COLD_WORKER_START_MS = 180;
const WARM_WORKER_START_MS = 5;

let sharedPool: FindSuggestionPool | undefined;

/** 使用已有条目数和 query 复杂度估算本地与分块 worker 的墙钟成本。 */
export function shouldOffloadFindSuggestions(
	entryCount: number,
	queryTermCount: number,
	options: FindSuggestionDecisionOptions = {},
): boolean {
	if (entryCount <= 0) return false;
	const concurrency = Math.max(1, options.concurrency ?? FIND_CONCURRENCY);
	const workers = Math.min(concurrency, Math.ceil(entryCount / FIND_SUGGESTION_CHUNK_SIZE));
	if (workers <= 1) return false;
	const workUnits = entryCount * Math.max(1, queryTermCount) * FUSE_FIELDS;
	const localMs = workUnits / LOCAL_WORK_UNITS_PER_MS;
	const transferMs = entryCount / TRANSFER_ENTRIES_PER_MS;
	const startupMs = (options.workerWarm ?? sharedPool?.isWarm() === true) ? WARM_WORKER_START_MS : COLD_WORKER_START_MS;
	return startupMs + localMs / workers + transferMs < localMs;
}

/** 主匹配留在本进程；只有零结果的全量 typo suggestions 才按独立文档块并行。 */
export async function rankFindEntriesForSearch(
	entries: FindEntry[],
	query: string,
	rootPath: string,
	signal?: AbortSignal,
): Promise<RankedFindEntries> {
	const matches = rankFindMatches(entries, query, rootPath);
	if (matches.length > 0) return { matches, suggestions: [] };
	const queryTermCount = query.split(/[\/\s._-]+/u).filter(Boolean).length;
	if (!shouldOffloadFindSuggestions(entries.length, queryTermCount)) {
		return { matches, suggestions: rankFindSuggestions(entries, query, rootPath) };
	}
	if (signal?.aborted) throw new AbortFindSuggestionRanking();
	try {
		sharedPool ??= new FindSuggestionPool(FIND_CONCURRENCY);
		const workers = Math.min(FIND_CONCURRENCY, Math.ceil(entries.length / FIND_SUGGESTION_CHUNK_SIZE));
		const chunkSize = Math.ceil(entries.length / workers);
		const tasks: Array<Promise<string[]>> = [];
		for (let start = 0; start < entries.length; start += chunkSize) {
			tasks.push(sharedPool.run(
				entries.slice(start, start + chunkSize).map((entry) => ({ path: entry.path, kind: entry.kind })),
				query,
				rootPath,
				signal,
			));
		}
		const shortlistPaths = (await Promise.all(tasks)).flat();
		const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
		const shortlist = shortlistPaths.map((entryPath) => entriesByPath.get(entryPath)).filter((entry): entry is FindEntry => entry !== undefined);
		return { matches, suggestions: rankFindSuggestions(shortlist, query, rootPath) };
	} catch (error) {
		if (error instanceof AbortFindSuggestionRanking) throw error;
		return { matches, suggestions: rankFindSuggestions(entries, query, rootPath) };
	}
}

export function clearFindSuggestionPool(): void {
	sharedPool?.dispose();
	sharedPool = undefined;
}

export class AbortFindSuggestionRanking extends Error {}

class FindSuggestionPool {
	private readonly queue: SuggestionTask[] = [];
	private readonly slots = new Set<WorkerSlot>();
	private nextTaskId = 1;
	private disposed = false;

	constructor(private readonly workerLimit: number) {}

	isWarm(): boolean {
		return this.slots.size > 0;
	}

	run(
		entries: Array<Pick<FindEntry, "path" | "kind">>,
		query: string,
		rootPath: string,
		signal?: AbortSignal,
	): Promise<string[]> {
		if (this.disposed) return Promise.reject(new Error("find suggestion pool is disposed"));
		return new Promise((resolve, reject) => {
			const task: SuggestionTask = {
				id: this.nextTaskId,
				entries,
				query,
				rootPath,
				resolve,
				reject,
				...(signal !== undefined ? { signal } : {}),
				settled: false,
			};
			this.nextTaskId += 1;
			if (signal?.aborted) {
				task.settled = true;
				reject(new AbortFindSuggestionRanking());
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
		for (const task of this.queue.splice(0)) this.rejectTask(task, new AbortFindSuggestionRanking());
		for (const slot of this.slots) {
			if (slot.task !== undefined) this.rejectTask(slot.task, new AbortFindSuggestionRanking());
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
			slot.worker.postMessage({ id: task.id, entries: task.entries, query: task.query, rootPath: task.rootPath });
		}
	}

	private spawnWorker(): void {
		const worker = new Worker(new URL("./suggestion-worker.ts", import.meta.url), { execArgv: ["--import", "jiti/register"] });
		const slot: WorkerSlot = { worker, stopping: false };
		this.slots.add(slot);
		worker.on("message", (response: SuggestionWorkerResponse) => this.finishTask(slot, response));
		worker.on("error", (error) => this.failWorker(slot, error instanceof Error ? error : new Error(String(error))));
		worker.on("exit", (code) => {
			if (!slot.stopping && code !== 0) this.failWorker(slot, new Error(`find suggestion worker exited with code ${code}`));
		});
		worker.unref();
	}

	private nextQueuedTask(): SuggestionTask | undefined {
		while (this.queue.length > 0) {
			const task = this.queue.shift();
			if (task !== undefined && !task.settled) return task;
		}
		return undefined;
	}

	private finishTask(slot: WorkerSlot, response: SuggestionWorkerResponse): void {
		const task = slot.task;
		if (task === undefined || response.id !== task.id) {
			this.failWorker(slot, new Error("find suggestion worker returned an unexpected task"));
			return;
		}
		delete slot.task;
		slot.worker.unref();
		if (response.paths !== undefined) this.resolveTask(task, response.paths);
		else this.rejectTask(task, new Error(response.error ?? "find suggestion worker failed"));
		this.dispatch();
	}

	private failWorker(slot: WorkerSlot, error: Error): void {
		if (!this.slots.delete(slot)) return;
		slot.stopping = true;
		void slot.worker.terminate();
		if (slot.task !== undefined) this.rejectTask(slot.task, error);
		this.dispatch();
	}

	private abortTask(task: SuggestionTask): void {
		if (task.settled) return;
		const queuedIndex = this.queue.indexOf(task);
		if (queuedIndex >= 0) {
			this.queue.splice(queuedIndex, 1);
			this.rejectTask(task, new AbortFindSuggestionRanking());
			return;
		}
		const slot = Array.from(this.slots).find((candidate) => candidate.task === task);
		if (slot !== undefined) {
			this.slots.delete(slot);
			slot.stopping = true;
			delete slot.task;
			this.rejectTask(task, new AbortFindSuggestionRanking());
			void slot.worker.terminate();
			this.dispatch();
		}
	}

	private resolveTask(task: SuggestionTask, paths: string[]): void {
		if (task.settled) return;
		task.settled = true;
		this.removeAbortListener(task);
		task.resolve(paths);
	}

	private rejectTask(task: SuggestionTask, error: Error): void {
		if (task.settled) return;
		task.settled = true;
		this.removeAbortListener(task);
		task.reject(error);
	}

	private removeAbortListener(task: SuggestionTask): void {
		if (task.signal !== undefined && task.onAbort !== undefined) task.signal.removeEventListener("abort", task.onAbort);
		delete task.onAbort;
	}
}
