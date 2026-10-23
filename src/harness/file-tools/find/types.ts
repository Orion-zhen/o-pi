import type { SearchNavigation } from "../shared/search-navigation.ts";
import type { FileToolError } from "../shared/result.ts";

import type { Static } from "typebox";
import type { findParameters } from "./schema.ts";

export type FindParams = Static<typeof findParameters>;

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

export type FindTruncationReason = "depth_limit" | "entry_limit" | "result_limit";

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
	stats: FindStats;
	truncated_by: FindTruncationReason[];
	navigation?: SearchNavigation;
}

export interface FindSuccess {
	content: string;
	details: FindDetails;
}
