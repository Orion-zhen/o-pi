import type { IndexedImport, ParsedFileIndex } from "../code-index/types.js";
import type { JavaScriptSyntaxFacts } from "./syntax-facts.js";
import type { RepoMapFileRecord } from "./types.js";

export interface RepoMapParserRequest {
	id: number;
	root: string;
	files: RepoMapFileRecord[];
}

export interface RepoMapParserFileResult {
	file: RepoMapFileRecord;
	status: "parsed" | "unsupported" | "error";
	index?: ParsedFileIndex;
	imports?: IndexedImport[];
	syntaxFacts?: JavaScriptSyntaxFacts;
	diagnostic?: { code: "FILE_CHANGED_DURING_PARSE" | "PARSER_ERROR"; message: string };
}

export interface RepoMapParserResponse {
	id: number;
	results?: RepoMapParserFileResult[];
	error?: string;
}
