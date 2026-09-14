import { Worker } from "node:worker_threads";
import path from "node:path";
import { binaryResourceDir } from "../runtime/paths.js";

export function createTypeScriptWorker(entry: URL): Worker {
	return new Worker(binaryResourceDir === undefined
		? entry
		: path.join(binaryResourceDir, "workers", `${path.basename(entry.pathname, ".ts")}.mjs`));
}
