import { countTextTokensSync } from "../../token-counter.js";
import type {
	FindDetails,
	FindMatch,
	FindScopeError,
	FindStats,
	FindTruncationReason,
} from "./types.js";

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
	resultLimited: boolean;
	outputTokenBudget: number;
}

/** 模型正文始终是 relevance 顺序的具体路径；不折叠、不混入非命中候选。 */
export function renderFindResults(input: RenderFindInput): { content: string; details: FindDetails } {
	const initialReasons: FindTruncationReason[] = [
		...(input.depthLimited ? ["depth_limit" as const] : []),
		...(input.resultLimited ? ["result_limit" as const] : []),
	];
	if (input.totalMatches === 0) return renderNoMatches(input, initialReasons);

	const completeLines = resultLines(input, initialReasons, input.matches);
	if (tokenCount(completeLines.join("\n")) <= input.outputTokenBudget) {
		return buildResult(input, completeLines.join("\n"), input.matches, initialReasons);
	}

	const reasons = [...initialReasons, "output_limit" as const];
	const prefix = prefixLines(input, reasons);
	const lines = takeBudgetedLines(prefix, input.outputTokenBudget);
	const displayed: FindMatch[] = [];
	for (const match of input.matches) {
		const line = formatMatch(match);
		const next = [...lines, line].join("\n");
		if (tokenCount(next) > input.outputTokenBudget) break;
		lines.push(line);
		displayed.push(match);
	}
	return buildResult(input, lines.join("\n"), displayed, reasons);
}

function renderNoMatches(
	input: RenderFindInput,
	initialReasons: FindTruncationReason[],
): { content: string; details: FindDetails } {
	const payload = [
		"none",
		`searched=${input.totalCandidates}; ignored=${input.stats.ignored_entries}; skipped=${input.stats.skipped_entries}`,
		"next: refine query/path/glob",
	];
	const complete = [...prefixLines(input, initialReasons), ...payload];
	const lines = takeBudgetedLines(complete, input.outputTokenBudget);
	const reasons = lines.length === complete.length
		? initialReasons
		: [...initialReasons, "output_limit" as const];
	const finalLines = reasons === initialReasons
		? lines
		: takeBudgetedLines([...prefixLines(input, reasons), ...payload], input.outputTokenBudget);
	return buildResult(input, finalLines.join("\n"), [], reasons);
}

function resultLines(
	input: RenderFindInput,
	reasons: readonly FindTruncationReason[],
	matches: readonly FindMatch[],
): string[] {
	return [...prefixLines(input, reasons), ...matches.map(formatMatch)];
}

function prefixLines(
	input: RenderFindInput,
	reasons: readonly FindTruncationReason[],
): string[] {
	const lines: string[] = [];
	if (reasons.length > 0) {
		lines.push(`matched=${input.totalMatches} selected=${input.matches.length}; truncated=${reasons.join(",")}`);
	}
	const warning = scopeWarning(input.scopeErrors);
	if (warning !== undefined) lines.push(warning);
	return lines;
}

function scopeWarning(errors: readonly FindScopeError[] | undefined): string | undefined {
	if (errors === undefined || errors.length === 0) return undefined;
	return `partial; scope_errors=${errors.map(({ path, error }) => `${path}:${error.code}`).join(",")}`;
}

function buildResult(
	input: RenderFindInput,
	content: string,
	displayedMatches: readonly FindMatch[],
	truncatedBy: readonly FindTruncationReason[],
): { content: string; details: FindDetails } {
	return {
		content,
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
			matches: input.matches.map(copyMatch),
			displayed_matches: displayedMatches.map(copyMatch),
			stats: input.stats,
			truncated_by: [...truncatedBy],
			ranking: { algorithm: "fzf-v2-path-v1" },
		},
	};
}

function copyMatch(match: FindMatch): FindMatch {
	return { path: match.path, kind: match.kind };
}

function formatMatch(match: FindMatch): string {
	return match.kind === "directory" ? `${match.path}/` : match.path;
}

function takeBudgetedLines(lines: readonly string[], tokenBudget: number): string[] {
	const selected: string[] = [];
	for (const line of lines) {
		const next = [...selected, line].join("\n");
		if (tokenCount(next) > tokenBudget) break;
		selected.push(line);
	}
	return selected;
}

function tokenCount(value: string): number {
	return countTextTokensSync(value).tokens;
}
