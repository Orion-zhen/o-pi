import { workerData } from "node:worker_threads";
import { createJiti } from "jiti";

if (typeof workerData !== "string") throw new Error("TypeScript worker entry is required.");
await createJiti(import.meta.url).import(workerData);
