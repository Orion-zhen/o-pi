import { createTypeScriptWorker } from "../worker-runtime/typescript-worker.ts";
import { WorkerTaskPool } from "../worker-runtime/worker-task-pool.ts";
import type { HeicPngResult } from "./heic.ts";

export async function convertHeicToPng(bytes: Uint8Array, signal?: AbortSignal): Promise<HeicPngResult> {
	const worker = new WorkerTaskPool<Uint8Array, HeicPngResult>({
		workerLimit: 1,
		workerName: "HEIC",
		createWorker: () => createTypeScriptWorker(new URL("./heic-worker.ts", import.meta.url)),
	});
	try {
		return await worker.run(bytes, signal);
	} finally {
		worker.dispose();
	}
}
