import { parentPort } from "node:worker_threads";

import { analyzeCodeFile } from "../../code-index/parser.js";
import type { AnalyzedFileIndex } from "../../code-index/types.js";

interface ParseRequest {
	id: number;
	files: Array<{ path: string; text: string }>;
}

interface ParseSuccess {
	id: number;
	results: AnalyzedFileIndex[];
}

interface ParseFailure {
	id: number;
	error: string;
}

if (parentPort === null) throw new Error("grep parser worker requires a parent port");
const workerPort = parentPort;

workerPort.on("message", (request: ParseRequest) => {
	void handle(request);
});

async function handle(request: ParseRequest): Promise<void> {
	try {
		const results = await Promise.all(request.files.map((file) =>
			analyzeCodeFile(file.path, file.text)));
		const response: ParseSuccess = { id: request.id, results };
		workerPort.postMessage(response);
	} catch (error) {
		const response: ParseFailure = { id: request.id, error: error instanceof Error ? error.message : String(error) };
		workerPort.postMessage(response);
	}
}
