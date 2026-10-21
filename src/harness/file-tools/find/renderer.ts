import { formatSearchNavigation, type SearchNavigation } from "../shared/search-navigation.ts";
import type {
	FindMatch,
	FindScopeError,
	FindStats,
	FindSuccess,
	FindTruncationReason,
} from "./types.ts";

export interface RenderFindInput {
	query: string;
	path: string;
	paths: string[];
	glob?: string;
	scopeErrors?: FindScopeError[];
	totalCandidates: number;
	totalMatches: number;
	matches: FindMatch[];
	stats: FindStats;
	depthLimited: boolean;
	entryLimited: boolean;
	resultLimited: boolean;
	navigation: SearchNavigation;
}

/** 按排名器的选择顺序完整展示具体路径，不折叠或混入非命中候选。 */
export function renderFindResults(input: RenderFindInput): FindSuccess {
	const truncatedBy: FindTruncationReason[] = [
		...(input.depthLimited ? ["depth_limit" as const] : []),
		...(input.entryLimited ? ["entry_limit" as const] : []),
		...(input.resultLimited ? ["result_limit" as const] : []),
	];
	const lines: string[] = [];
	if (truncatedBy.length > 0) {
		lines.push(`matched=${input.totalMatches} selected=${input.matches.length}; truncated=${truncatedBy.join(",")}`);
	}
	const warning = scopeWarning(input.scopeErrors);
	if (warning !== undefined) lines.push(warning);
	if (input.totalMatches === 0) {
		lines.push("none", `searched=${input.totalCandidates}; ignored=${input.stats.ignored_entries}; skipped=${input.stats.skipped_entries}`);
		if (truncatedBy.length === 0) lines.push("next: refine query/path/glob");
	} else {
		lines.push(...input.matches.map(formatMatch));
	}
	if (truncatedBy.length > 0) lines.push(...formatSearchNavigation(input.navigation));

	return {
		content: lines.join("\n"),
		details: {
			status: "success",
			query: input.query,
			path: input.path,
			paths: input.paths,
			...(input.glob === undefined ? {} : { glob: input.glob }),
			...(input.scopeErrors === undefined || input.scopeErrors.length === 0
				? {}
				: { scope_errors: input.scopeErrors }),
			total_candidates: input.totalCandidates,
			total_matches: input.totalMatches,
			returned_matches: input.matches.length,
			matches: input.matches.map((match) => ({ path: match.path, kind: match.kind })),
			stats: input.stats,
			truncated_by: truncatedBy,
			...(truncatedBy.length === 0 ? {} : { navigation: input.navigation }),
		},
	};
}

function scopeWarning(errors: readonly FindScopeError[] | undefined): string | undefined {
	if (errors === undefined || errors.length === 0) return undefined;
	return `partial; scope_errors=${errors.map(({ path, error }) => `${path}:${error.code}`).join(",")}`;
}

function formatMatch(match: FindMatch): string {
	return match.kind === "directory" ? `${match.path}/` : match.path;
}
