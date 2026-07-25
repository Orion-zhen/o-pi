import { parentPort } from "node:worker_threads";
import { loadTypeScript } from "../benchmark/loader.mjs";

const port = parentPort;
if (port === null) throw new Error("code-index benchmark worker requires a parent port");
const parser = await loadTypeScript("src/code-index/parser.ts");
port.on("message", (request) => {
	void Promise.all(request.paths.map((filePath) => parser.analyzeCodeFile(filePath, request.text)))
		.then((results) => port.postMessage(results.map((result) => ({ units: result.index.units.length, imports: result.imports.length }))));
});
