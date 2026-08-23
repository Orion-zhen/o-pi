import type { NewlineKind } from "../../filesystem/contracts/content.js";

export interface ReadParams {
	path: string;
	lines?: string;
	pages?: string;
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

export interface ReadPdfMetadata {
	title?: string;
	author?: string;
	subject?: string;
	keywords?: string;
	creator?: string;
	producer?: string;
	creation_date?: string;
	modification_date?: string;
	pdf_version?: string;
}

export interface ReadPdfPage {
	number: number;
	label?: string;
	width_points: number;
	height_points: number;
	rotation: number;
	image: {
		data: string;
		mime_type: string;
	};
	hints?: string[];
}

export interface ReadPdfSuccess {
	path: string;
	media_type: "pdf";
	mime_type: "application/pdf";
	size_bytes: number;
	version: string;
	start_page: number;
	end_page: number;
	total_pages: number;
	truncated: boolean;
	continuation?: { start_page: number };
	metadata: ReadPdfMetadata;
	pages: ReadPdfPage[];
	ignored?: boolean;
	ignore_source?: string;
	skill_resource?: { skill: string; path: string };
}

export type ReadFileSuccess = ReadSuccess | ReadImageSuccess | ReadPdfSuccess;
