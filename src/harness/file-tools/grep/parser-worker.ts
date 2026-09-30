import { parentPort } from "node:worker_threads";

import { analyzeCodeFile } from "../../code-index/parser.ts";
import type { AnalyzedFileIndex } from "../../code-index/types.ts";
import type { WorkerTaskRequest, WorkerTaskResponse } from "../../worker-runtime/worker-task-pool.ts";
import type { GrepParseFile } from "./parser-pool.ts";

if (parentPort === null) throw new Error("grep parser worker requires a parent port");
const workerPort = parentPort;

workerPort.on("message", async ({ id, request }: WorkerTaskRequest<GrepParseFile[]>) => {
	let response: WorkerTaskResponse<AnalyzedFileIndex[]>;
	try {
		const result = await Promise.all(request.map((file) => analyzeCodeFile(file.path, file.text)));
		response = { id, result };
	} catch (error) {
		response = { id, error: error instanceof Error ? error.message : String(error) };
	}
	workerPort.postMessage(response);
});
