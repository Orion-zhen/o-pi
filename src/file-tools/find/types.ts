import type { FileToolError } from "../shared/result.js";

/** find routes a query to exact path, glob, or fuzzy/graph search. */
export interface FindParams {
	query: string;
	path?: string[];
}

export type FindEntryKind = "file" | "directory";

/** Path-only ranking document. It never contains source text. */
export interface FindEntry {
	path: string;
	kind: FindEntryKind;
	basename: string;
	stem: string;
	extension?: string;
	segments: string[];
	tokens: string[];
	depth: number;
}

export interface FindMatch {
	path: string;
	kind: FindEntryKind;
}

export interface FindNearbyResult extends FindMatch {
	reason: "name similarity";
}

export interface FindRelatedResult {
	path: string;
	kind: "file";
	source: "repo-map";
	relations: string[];
	query_match: "not_guaranteed";
}

export interface FindCollapsedGroup {
	path: string;
	files: number;
	directories: number;
}

export interface FindScopeError {
	path: string;
	error: FileToolError;
}

export interface FindDetails {
	query: string;
	/** First valid scope, retained for the single-scope protocol. */
	path: string;
	paths: string[];
	scope_errors?: FindScopeError[];
	strategy: "exact" | "glob" | "fuzzy";
	totalMatches: number;
	returnedMatches: number;
	scannedEntries: number;
	matches: FindMatch[];
	collapsedGroups: FindCollapsedGroup[];
	displayedMatches?: FindMatch[];
	displayedCollapsedGroups?: FindCollapsedGroup[];
	ignoredCount: number;
	skippedCount: number;
	scanTruncated: boolean;
	resultLimited: boolean;
	outputTruncated: boolean;
	related?: FindRelatedResult[];
	nearby?: FindNearbyResult[];
	missingPrefix?: string;
	nearbyDirectory?: string;
	candidateSources?: Record<string, string[]>;
}

export interface FindSuccess {
	content: string;
	details: FindDetails;
}
