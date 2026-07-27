import type { FileToolError } from "../shared/result.js";

export type GrepMatchMode = "auto" | "literal" | "regex";
export type QueryMatch = "verified" | "semantic" | "not_guaranteed";
export type TruncationReason =
	| "traversal_limit"
	| "text_byte_limit"
	| "semantic_candidate_limit"
	| "result_limit"
	| "token_budget";

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

export interface GrepStats {
	traversed_entries: number;
	searched_files: number;
	searched_bytes: number;
	parsed_files: number;
	skipped_files?: GrepSkippedFiles;
}

export interface GrepRegion {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol?: string;
	signature?: string;
	detail: "body" | "snippet" | "signature";
	query_match: "verified" | "semantic";
	reasons: string[];
	sources: string[];
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
	query_match: "not_guaranteed";
}

export interface GrepRelatedResult {
	path: string;
	kind: string;
	start_line?: number;
	end_line?: number;
	symbol?: string;
	signature?: string;
	sources: string[];
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
	total_candidates: number;
	returned_regions: number;
	returned_files: number;
	approx_tokens: number;
	stats: GrepStats;
	truncated_by: TruncationReason[];
	regions: GrepRegion[];
	nearby?: GrepNearbyResult[];
	related?: GrepRelatedResult[];
}
