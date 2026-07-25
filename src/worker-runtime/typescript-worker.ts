import { Worker } from "node:worker_threads";

const bootstrap = new URL("./typescript-worker-bootstrap.mjs", import.meta.url);

export function createTypeScriptWorker(entry: URL): Worker {
	return new Worker(bootstrap, { workerData: entry.href });
}
