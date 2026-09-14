import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";

import { DEFAULT_WORKER_CONCURRENCY } from "../../../src/harness/worker-runtime/concurrency.js";

describe("worker runtime", () => {
	it("uses a bounded non-zero default concurrency", () => {
		expect(DEFAULT_WORKER_CONCURRENCY).toBeGreaterThanOrEqual(1);
		expect(DEFAULT_WORKER_CONCURRENCY).toBeLessThanOrEqual(availableParallelism());
	});
});
