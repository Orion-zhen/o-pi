import type { FileToolError } from "../shared/result.js";

export type GrepMatchedBy =
	| "exact-qualified-symbol"
	| "exact-symbol"
	| "symbol-prefix"
	| "regex"
	| "lexical"
	| "related";
export type TruncationReason =
	| "traversal_limit"
	| "result_limit";

export interface GrepParams {
	query: string;
	path?: string[];
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
	text_hits: number;
	parsed_files: number;
	/** 内部容量观测；不进入模型截断状态。 */
	dropped_text_hits: number;
	dropped_related_anchors: number;
	dropped_related_results: number;
	ast_skipped_oversized_files: number;
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

export type GrepRankingSelection = "head" | "mmr";

export interface GrepRegionRanking {
	relevance_rank: number;
	tier: number;
	primary_score: number;
	auxiliary_score: number;
	selection: GrepRankingSelection;
}

/** details/telemetry only；不进入模型正文或 TUI 结果区域。 */
export interface GrepRankingDiagnostics {
	algorithm: string;
	candidate_count: number;
	eligible_candidate_count: number;
	selected_candidate_count: number;
	relevance_head_size: number;
	tier_count: number;
	top_tier_candidate_count: number;
	mmr_selected_count: number;
	mmr_replacement_count: number;
	relevance_prefix_file_count: number;
	selected_file_count: number;
	regions: GrepRegionRanking[];
}

export interface GrepSuccess {
	status: "success";
	query: string;
	path: string;
	paths?: string[];
	scope_errors?: GrepScopeError[];
	total_candidates: number;
	returned_regions: number;
	returned_files: number;
	approx_tokens: number;
	stats: GrepStats;
	truncated_by: TruncationReason[];
	regions: GrepRegion[];
	ranking?: GrepRankingDiagnostics;
}
