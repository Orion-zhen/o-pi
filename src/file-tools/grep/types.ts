import type { FileToolError } from "../shared/result.js";

export type GrepMatchMode = "auto" | "literal" | "regex";

export interface GrepParams {
	query: string;
	path?: string[];
	match?: GrepMatchMode;
	glob?: string;
}

export interface GrepSkippedFiles {
	binary?: number;
	invalid_utf8?: number;
	access_denied?: number;
	too_large?: number;
}

export interface GrepRegion {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol?: string;
	signature?: string;
	detail: "body" | "snippet" | "signature";
	reasons: string[];
	sources?: string[];
	match_lines?: number[];
	content?: string;
	callees?: string[];
	imports?: string[];
}

export interface GrepNearbyResult {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol?: string;
	signature?: string;
	reason: "symbol similarity" | "partial terms" | "path similarity";
}

export interface GrepRelatedResult {
	path: string;
	kind: string;
	start_line?: number;
	end_line?: number;
	symbol?: string;
	signature?: string;
	source: "repo-map";
	relations: string[];
	query_match: "not_guaranteed";
}

export interface GrepScopeError {
	path: string;
	error: FileToolError;
}

export interface GrepSuccess {
	status: "success";
	query: string;
	path: string;
	paths?: string[];
	scope_errors?: GrepScopeError[];
	match: GrepMatchMode;
	strategy: string[];
	total_candidates: number;
	returned_regions: number;
	returned_files: number;
	approx_tokens: number;
	scanned_files: number;
	truncated: boolean;
	regions: GrepRegion[];
	related?: GrepRelatedResult[];
	skipped_files?: GrepSkippedFiles;
	nearby?: GrepNearbyResult[];
}
