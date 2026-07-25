import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import { WorkerTaskAbortedError, WorkerTaskPool, type WorkerTaskResponse } from "../../src/worker-runtime/worker-task-pool.js";

const pools: Array<WorkerTaskPool<number, number>> = [];

afterEach(() => {
	for (const pool of pools.splice(0)) pool.dispose();
});

describe("WorkerTaskPool", () => {
	it("keeps request results deterministic across bounded workers", async () => {
		const pool = createPool("parentPort.on('message', ({ id, value }) => parentPort.postMessage({ id, result: value * 2 }));");
		const results = await Promise.all([pool.run(3), pool.run(1), pool.run(2)]);
		expect(results).toEqual([6, 2, 4]);
	});

	it("terminates active work on abort and reports worker crashes", async () => {
		const controller = new AbortController();
		const pool = createPool("parentPort.on('message', () => {});");
		const aborted = pool.run(1, controller.signal);
		controller.abort();
		await expect(aborted).rejects.toBeInstanceOf(WorkerTaskAbortedError);
		pool.dispose();

		const crashedPool = createPool("throw new Error('crashed');");
		const crashed = crashedPool.run(1);
		await expect(crashed).rejects.toThrow("crashed");
		crashedPool.dispose();
	});

	it("removes queued abort listeners and rejects all work on idempotent dispose", async () => {
		const pool = createPool("parentPort.on('message', () => {});", 1);
		const active = pool.run(1);
		const controller = new AbortController();
		const queued = pool.run(2, controller.signal);
		controller.abort();

		await expect(queued).rejects.toBeInstanceOf(WorkerTaskAbortedError);
		expect(pool.workerCount).toBe(1);
		pool.dispose();
		pool.dispose();
		await expect(active).rejects.toBeInstanceOf(WorkerTaskAbortedError);
		expect(pool.workerCount).toBe(0);
		await expect(pool.run(3)).rejects.toThrow("test pool is disposed");
	});
});

function createPool(source: string, workerLimit = 2): WorkerTaskPool<number, number> {
	const pool = new WorkerTaskPool<number, number>({
		workerLimit,
		createWorker: () => new Worker(`const { parentPort } = require('node:worker_threads'); ${source}`, { eval: true }),
		workerName: "test",
		requestForTask: (id, value) => ({ id, value }),
		decodeResponse: decode,
	});
	pools.push(pool);
	return pool;
}

function decode(message: unknown): WorkerTaskResponse<number> | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (typeof record.id !== "number") return undefined;
	if (typeof record.result === "number") return { id: record.id, result: record.result };
	return typeof record.error === "string" ? { id: record.id, error: record.error } : undefined;
}
