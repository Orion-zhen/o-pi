import { parentPort } from "node:worker_threads";

import { analyzeCodeFile, analyzeTextFile, type AnalyzedFileIndex } from "../../code-index/parser.js";

interface ParseRequest {
	id: number;
	files: Array<{ path: string; text: string; syntax: boolean }>;
}

interface ParseSuccess {
	id: number;
	results: AnalyzedFileIndex[];
}

interface ParseFailure {
	id: number;
	error: string;
}

const port = parentPort;
if (port === null) throw new Error("grep parser worker requires a parent port");

port.on("message", (request: ParseRequest) => {
	try {
		const response: ParseSuccess = {
			id: request.id,
			results: request.files.map((file) => file.syntax ? analyzeCodeFile(file.path, file.text) : analyzeTextFile(file.path)),
		};
		port.postMessage(response);
	} catch (error) {
		const response: ParseFailure = { id: request.id, error: error instanceof Error ? error.message : String(error) };
		port.postMessage(response);
	}
});
