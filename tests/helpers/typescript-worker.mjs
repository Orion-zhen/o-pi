import { workerData } from "node:worker_threads";
import { createJiti } from "jiti";
await createJiti(import.meta.url).import(workerData);
