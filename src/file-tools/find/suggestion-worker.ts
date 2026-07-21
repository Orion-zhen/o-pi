import { parentPort } from "node:worker_threads";

import { createFindEntry, rankFindSuggestions } from "./ranker.js";
import type { FindEntry } from "../types.js";

interface SuggestionRequest {
	id: number;
	entries: Array<Pick<FindEntry, "path" | "kind">>;
	query: string;
	rootPath: string;
}

interface SuggestionResponse {
	id: number;
	paths?: string[];
	error?: string;
}

const port = parentPort;
if (port === null) throw new Error("find suggestion worker requires a parent port");

port.on("message", (request: SuggestionRequest) => {
	let response: SuggestionResponse;
	try {
		const entries = request.entries.map((entry) => createFindEntry(entry.path, entry.kind));
		response = {
			id: request.id,
			paths: rankFindSuggestions(entries, request.query, request.rootPath).map((candidate) => candidate.entry.path),
		};
	} catch (error) {
		response = { id: request.id, error: error instanceof Error ? error.message : String(error) };
	}
	port.postMessage(response);
});
