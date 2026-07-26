import type { Worker } from "node:worker_threads";

import type { FindEntry } from "./types.js";
import { DEFAULT_WORKER_CONCURRENCY } from "../../worker-runtime/concurrency.js";
import { createTypeScriptWorker } from "../../worker-runtime/typescript-worker.js";
import { WorkerTaskAbortedError, WorkerTaskPool, type WorkerTaskResponse } from "../../worker-runtime/worker-task-pool.js";
import { rankFindMatches, rankFindSuggestions, type RankedFindEntries } from "./ranker.js";

interface SuggestionWorkerRequest {
	entries: Array<Pick<FindEntry, "path" | "kind">>;
	query: string;
	rootPath: string;
}

type FindSuggestionWorkerPool = WorkerTaskPool<SuggestionWorkerRequest, string[]>;

export interface FindSuggestionDecisionOptions {
	concurrency?: number;
	workerWarm?: boolean;
}

export interface FindSuggestionRankerOptions {
	workerLimit?: number;
	createWorker?: () => Worker;
}

export const FIND_CONCURRENCY = DEFAULT_WORKER_CONCURRENCY;
export const FIND_SUGGESTION_CHUNK_SIZE = 4_096;
const FUSE_FIELDS = 6;
const LOCAL_WORK_UNITS_PER_MS = 170;
const TRANSFER_ENTRIES_PER_MS = 80;
const COLD_WORKER_START_MS = 180;
const WARM_WORKER_START_MS = 5;

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
	const startupMs = options.workerWarm === true ? WARM_WORKER_START_MS : COLD_WORKER_START_MS;
	return startupMs + localMs / workers + transferMs < localMs;
}

/** Owns find suggestion ranking decisions and adapts them to the shared worker runtime. */
export class FindSuggestionRanker {
	private readonly workerLimit: number;
	private readonly createWorker: () => Worker;
	private pool: FindSuggestionWorkerPool | undefined;
	private disposed = false;

	constructor(options: FindSuggestionRankerOptions = {}) {
		this.workerLimit = Math.max(1, options.workerLimit ?? FIND_CONCURRENCY);
		this.createWorker = options.createWorker ?? (() => createTypeScriptWorker(new URL("./suggestion-worker.ts", import.meta.url)));
	}

	/** Main matching stays local; only zero-result typo suggestions may be offloaded. */
	async rank(entries: FindEntry[], query: string, rootPath: string, signal?: AbortSignal): Promise<RankedFindEntries> {
		if (this.disposed || isAborted(signal)) throw new AbortFindSuggestionRanking();
		const matches = rankFindMatches(entries, query, rootPath);
		if (matches.length > 0) return { matches, suggestions: [] };
		const queryTermCount = query.split(/[\/\s._-]+/u).filter(Boolean).length;
		if (!shouldOffloadFindSuggestions(entries.length, queryTermCount, {
			concurrency: this.workerLimit,
			workerWarm: (this.pool?.workerCount ?? 0) > 0,
		})) {
			return { matches, suggestions: rankFindSuggestions(entries, query, rootPath) };
		}
		try {
			this.pool ??= createFindSuggestionWorkerPool(this.workerLimit, this.createWorker);
			const workers = Math.min(this.workerLimit, Math.ceil(entries.length / FIND_SUGGESTION_CHUNK_SIZE));
			const chunkSize = Math.ceil(entries.length / workers);
			const tasks: Array<Promise<string[]>> = [];
			for (let start = 0; start < entries.length; start += chunkSize) {
				tasks.push(this.pool.run({
					entries: entries.slice(start, start + chunkSize).map((entry) => ({ path: entry.path, kind: entry.kind })),
					query,
					rootPath,
				}, signal));
			}
			const shortlistPaths = (await Promise.all(tasks)).flat();
			const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
			const shortlist = shortlistPaths.map((entryPath) => entriesByPath.get(entryPath)).filter((entry): entry is FindEntry => entry !== undefined);
			return { matches, suggestions: rankFindSuggestions(shortlist, query, rootPath) };
		} catch (error) {
			if (this.disposed || isAborted(signal) || error instanceof WorkerTaskAbortedError) {
				throw new AbortFindSuggestionRanking();
			}
			return { matches, suggestions: rankFindSuggestions(entries, query, rootPath) };
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pool?.dispose();
		this.pool = undefined;
	}
}

export class AbortFindSuggestionRanking extends Error {}

function createFindSuggestionWorkerPool(workerLimit: number, createWorker: () => Worker): FindSuggestionWorkerPool {
	return new WorkerTaskPool<SuggestionWorkerRequest, string[]>({
		workerLimit,
		createWorker,
		workerName: "find suggestion",
		requestForTask: (id, request) => ({ id, ...request }),
		decodeResponse: decodeFindSuggestionResponse,
	});
}

function decodeFindSuggestionResponse(message: unknown): WorkerTaskResponse<string[]> | undefined {
	if (!isRecord(message) || typeof message.id !== "number" || !Number.isSafeInteger(message.id) || message.id < 1) return undefined;
	if (isStringArray(message.paths) && message.error === undefined) return { id: message.id, result: message.paths };
	if (typeof message.error === "string" && message.paths === undefined) return { id: message.id, error: message.error };
	return undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
