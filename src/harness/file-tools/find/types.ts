import type { SearchNavigation } from "../shared/search-navigation.js";
import type { FileToolError } from "../shared/result.js";

/** 模型只提供查询、候选 scope 和可选候选 glob；其余匹配策略由 find runtime 固定。 */
export interface FindParams {
	query: string;
	path?: string[];
	glob?: string;
}

export type FindEntryKind = "file" | "directory";

export interface FindEntry {
	path: string;
	searchPath: string;
	kind: FindEntryKind;
	scopeOrder: number;
}

export interface FindMatch {
	path: string;
	kind: FindEntryKind;
}

export interface FindScopeError {
	path: string;
	error: FileToolError;
}

export type FindTruncationReason = "depth_limit" | "entry_limit" | "result_limit" | "output_limit";

export interface FindStats {
	traversed_entries: number;
	ignored_entries: number;
	skipped_entries: number;
}

export interface FindDetails {
	status: "success";
	query: string;
	path: string;
	paths: string[];
	glob?: string;
	scope_errors?: FindScopeError[];
	total_candidates: number;
	total_matches: number;
	returned_matches: number;
	matches: FindMatch[];
	displayed_matches: FindMatch[];
	stats: FindStats;
	truncated_by: FindTruncationReason[];
	navigation?: SearchNavigation;
}

export interface FindSuccess {
	content: string;
	details: FindDetails;
}
