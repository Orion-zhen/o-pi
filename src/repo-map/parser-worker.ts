import { createHash } from "node:crypto";
import path from "node:path";
import { parentPort } from "node:worker_threads";

import { analyzeCodeFile, languageFromPath } from "../code-index/parser.js";
import { readTextNoFollow, RepoMapReadLimitError } from "./source.js";
import { javascriptSyntaxFactsFromDocument } from "./syntax-facts.js";
import { PARSER_SYNTAX_DIAGNOSTIC, type RepoMapParserFileResult, type RepoMapParserRequest, type RepoMapParserResponse } from "./parser-task.js";

if (parentPort === null) throw new Error("Repo Map parser worker requires a parent port");
const workerPort = parentPort;

workerPort.on("message", (request: RepoMapParserRequest) => {
	void handle(request);
});

async function handle(request: RepoMapParserRequest): Promise<void> {
	try {
		const results: RepoMapParserFileResult[] = [];
		for (const file of request.files) results.push(await parseFile(request.root, file));
		const response: RepoMapParserResponse = { id: request.id, results };
		workerPort.postMessage(response);
	} catch (error) {
		const response: RepoMapParserResponse = { id: request.id, error: error instanceof Error ? error.message : String(error) };
		workerPort.postMessage(response);
	}
}

async function parseFile(root: string, file: RepoMapParserFileResult["file"]): Promise<RepoMapParserFileResult> {
	if (languageFromPath(file.path) === "text") return { file, status: "unsupported" };
	try {
		const text = await readTextNoFollow(path.join(root, file.path), undefined, file.size);
		if (file.contentHash === undefined || createHash("sha256").update(text).digest("hex") !== file.contentHash) {
			return {
				file,
				status: "error",
				diagnostic: { code: "FILE_CHANGED_DURING_PARSE", message: "File changed after scanning and was not parsed." },
			};
		}
		const analyzed = analyzeCodeFile(file.path, text);
		if (analyzed.status !== "parsed") {
			return {
				file,
				status: analyzed.status === "unsupported" ? "unsupported" : "error",
				...(analyzed.status === "error" ? { diagnostic: { code: "PARSER_ERROR", message: analyzed.failure?.message ?? "Tree-sitter could not parse this supported file." } } : {}),
			};
		}
		const syntaxFacts = analyzed.document === undefined || !isJavaScriptFamily(file.path)
			? undefined
			: javascriptSyntaxFactsFromDocument(file.path, analyzed.document);
		return {
			file,
			status: "parsed",
			index: analyzed.index,
			imports: analyzed.imports,
			...(syntaxFacts === undefined ? {} : { syntaxFacts }),
			...(analyzed.document?.root.hasError === true ? { diagnostic: PARSER_SYNTAX_DIAGNOSTIC } : {}),
		};
	} catch (error) {
		return {
			file,
			status: "error",
			diagnostic: error instanceof RepoMapReadLimitError
				? { code: "FILE_CHANGED_DURING_PARSE", message: "File changed after scanning and was not parsed." }
				: { code: "PARSER_ERROR", message: error instanceof Error ? `File could not be parsed: ${error.message}` : "File could not be parsed." },
		};
	}
}

function isJavaScriptFamily(filePath: string): boolean {
	return /\.(?:[cm]?js|jsx|tsx?)$/u.test(filePath);
}
