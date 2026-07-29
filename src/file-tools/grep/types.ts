import type { FileToolError } from "../shared/result.js";

export type GrepMatchMode = "auto" | "literal" | "regex";
export type GrepMatchedBy =
	| "exact-qualified-symbol"
	| "exact-symbol"
	| "symbol-prefix"
	| "literal"
	| "regex"
	| "lexical"
	| "relationship";
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
	changed?: number;
}

export interface GrepStats {
	traversed_entries: number;
	searched_files: number;
	searched_bytes: number;
	parsed_files: number;
	skipped_files?: GrepSkippedFiles;
}

export interface GrepDisplayLine {
	line: number;
	text: string;
	type: "match" | "evidence";
}

export interface GrepRegion {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol?: string;
	declaration?: string;
	query_match: "verified" | "semantic";
	roles?: string[];
	matched_by: GrepMatchedBy[];
	/** details/TUI/telemetry only；不进入模型正文。 */
	sources: string[];
	/** verified region 的完整唯一命中行号，不受展示限制影响。 */
	match_lines?: number[];
	display_lines?: GrepDisplayLine[];
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
}
