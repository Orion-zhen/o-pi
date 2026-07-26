import { availableParallelism } from "node:os";

/** Filesystem directory work uses half the logical cores, with at least one lane. */
export const DIRECTORY_ENTRY_CONCURRENCY = Math.max(1, Math.floor(availableParallelism() / 2));
