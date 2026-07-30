import { availableParallelism } from "node:os";

/** Filesystem directory work is I/O-bound; cap lanes to avoid seek amplification on slow storage. */
export const DIRECTORY_ENTRY_CONCURRENCY = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
