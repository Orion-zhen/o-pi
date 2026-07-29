import type { NewlineKind } from "../../filesystem/contracts/content.js";

export interface ReadParams {
	path: string;
	start_line?: number;
	end_line?: number;
}

export type ReadOutputFormat = "text" | "image";

export interface ReadRemainingSymbol {
	name: string;
	kind: string;
	line: number;
	end_line: number;
}

export interface ReadEnclosingSymbol {
	name: string;
	kind: string;
	line: number;
	end_line: number;
}

export interface ReadStructureContext {
	remaining_symbols?: ReadRemainingSymbol[];
	enclosing_symbol?: ReadEnclosingSymbol;
}

export interface ReadGraphContext {
	symbol: {
		id: string;
		kind: string;
		name?: string;
		qualifiedName?: string;
		startLine: number;
		endLine: number;
	};
	suggestedReads: Array<{
		path: string;
		line?: number;
		symbol?: string;
		relation: "caller" | "reference" | "registration";
	}>;
	suggestedTests: string[];
}

export interface ReadSuccess {
	path: string;
	content: string;
	start_line: number;
	end_line: number;
	total_lines: number;
	size_bytes: number;
	version: string;
	encoding: "utf-8";
	newline: NewlineKind;
	truncated: boolean;
	continuation?: { start_line: number };
	bom: boolean;
	ignored?: boolean;
	ignore_source?: string;
	lsp?: ReadStructureContext;
	repo_map?: ReadGraphContext;
	skill_resource?: { skill: string; path: string };
}

export interface ReadImageSuccess {
	path: string;
	media_type: "image";
	mime_type: string;
	skill_resource?: { skill: string; path: string };
	content: string;
	size_bytes: number;
	version: string;
	image: {
		data: string;
		mime_type: string;
	};
	hints?: string[];
	ignored?: boolean;
	ignore_source?: string;
}

export type ReadFileSuccess = ReadSuccess | ReadImageSuccess;
