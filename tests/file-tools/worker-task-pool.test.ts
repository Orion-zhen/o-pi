import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import { WorkerTaskAbortedError, WorkerTaskPool } from "../../src/file-tools/core/worker-task-pool.js";

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
});

function createPool(source: string): WorkerTaskPool<number, number> {
	const pool = new WorkerTaskPool<number, number>({
		workerLimit: 2,
		createWorker: () => new Worker(`const { parentPort } = require('node:worker_threads'); ${source}`, { eval: true }),
		workerName: "test",
		requestForTask: (id, value) => ({ id, value }),
		decodeResponse: decode,
	});
	pools.push(pool);
	return pool;
}

function decode(message: unknown): { id: number; result?: number; error?: string } | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (typeof record.id !== "number") return undefined;
	if (typeof record.result === "number") return { id: record.id, result: record.result };
	return typeof record.error === "string" ? { id: record.id, error: record.error } : undefined;
}
