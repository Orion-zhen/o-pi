import { availableParallelism } from "node:os";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

import { DEFAULT_WORKER_CONCURRENCY } from "../../src/worker-runtime/concurrency.js";
import { createTypeScriptWorker } from "../../src/worker-runtime/typescript-worker.js";

describe("worker runtime", () => {
	it("loads a TypeScript worker through the shared bootstrap", async () => {
		const worker = createTypeScriptWorker(new URL("./fixtures/echo-worker.ts", import.meta.url));
		try {
			worker.postMessage(21);
			await expect(once(worker, "message")).resolves.toEqual([42]);
		} finally {
			await worker.terminate();
		}
	});

	it("uses a bounded non-zero default concurrency", () => {
		expect(DEFAULT_WORKER_CONCURRENCY).toBeGreaterThanOrEqual(1);
		expect(DEFAULT_WORKER_CONCURRENCY).toBeLessThanOrEqual(availableParallelism());
	});
});
