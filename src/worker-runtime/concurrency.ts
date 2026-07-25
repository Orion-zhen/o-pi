import { availableParallelism } from "node:os";

/** CPU-heavy worker tasks default to half the logical cores, with at least one lane. */
export const DEFAULT_WORKER_CONCURRENCY = Math.max(1, Math.floor(availableParallelism() / 2));
