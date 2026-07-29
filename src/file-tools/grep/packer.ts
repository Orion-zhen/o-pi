import { countTextTokensSync } from "../../token-counter.js";
import type { RankedRegion } from "./candidates.js";
import {
	GREP_RANKING_ALGORITHM,
	GREP_RELEVANCE_HEAD_SIZE,
	selectRankedRegions,
} from "./ranking.js";
import type {
	GrepDisplayLine,
	GrepRankingDiagnostics,
	GrepRegion,
	GrepRegionRanking,
	GrepScopeError,
	GrepSkippedFiles,
	GrepStats,
	GrepSuccess,
	TruncationReason,
} from "./types.js";

const TRUNCATION_ORDER: readonly TruncationReason[] = [
	"traversal_limit",
	"result_limit",
];
const RELATED_MARKER = " [not match, related]";

export interface GrepPackInput {
	query: string;
	path: string;
	paths?: string[];
	scopeErrors?: GrepScopeError[];
	regions: readonly RankedRegion[];
	stats: Omit<GrepStats, "dropped_related_results">;
	truncationReasons: readonly TruncationReason[];
	resultLimit: number;
	relatedResultLimit: number;
	regionalDisplayLimit: number;
}

/** 先保留 relevance head，再从同 tier 候选中选择互补结果。 */
export function packGrepResults(input: GrepPackInput): GrepSuccess {
	const knownReasons = orderedReasons(input.truncationReasons);
	const limited = limitRelatedResults(input.regions, input.relatedResultLimit);
	const candidates = limited.regions;
	const selected = selectRankedRegions(candidates, input.resultLimit);
	const regions = selected
		.map((candidate) => publicRegion(candidate, input.regionalDisplayLimit));
	const reasons = orderedReasons([
		...knownReasons,
		...(candidates.length > regions.length ? ["result_limit" as const] : []),
	]);
	const ranking = rankingDiagnostics(input.regions, candidates, selected, input.resultLimit);
	const result = createSuccess(input, candidates.length, regions, reasons, limited.dropped, ranking);
	return { ...result, approx_tokens: tokenCount(renderGrepSuccess(result)) };
}

function limitRelatedResults(
	regions: readonly RankedRegion[],
	limit: number,
): { regions: RankedRegion[]; dropped: number } {
	const result: RankedRegion[] = [];
	let related = 0;
	let dropped = 0;
	for (const region of regions) {
		if (region.queryMatch === "semantic") {
			if (related >= limit) {
				dropped += 1;
				continue;
			}
			related += 1;
		}
		result.push(region);
	}
	return { regions: result, dropped };
}

function publicRegion(candidate: RankedRegion, displayLimit: number): GrepRegion {
	const displayLines = candidate.queryMatch === "verified"
		? representativeLines(candidate.displayLines, displayLimit)
		: candidate.displayLines.slice(0, displayLimit);
	const roles = [
		candidate.symbolRole === "enclosing" ? "occurrence" : candidate.symbolRole,
		candidate.authority,
	].filter((value): value is string => value !== undefined);
	return {
		path: candidate.path,
		start_line: candidate.startLine,
		end_line: candidate.endLine,
		kind: candidate.kind,
		...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
		...(candidate.declaration === undefined ? {} : { declaration: boundedDeclaration(candidate.declaration) }),
		query_match: candidate.queryMatch === "verified" ? "verified" : "semantic",
		...(roles.length === 0 ? {} : { roles: unique(roles) }),
		matched_by: [...candidate.matchedBy],
		sources: unique(candidate.evidence.map((item) => item.source).filter(isRetrievalSource)),
		...(candidate.matchLines.length === 0 ? {} : { match_lines: [...candidate.matchLines] }),
		...(displayLines.length === 0 ? {} : { display_lines: displayLines.map((line) => ({ ...line })) }),
	};
}

function representativeLines(lines: readonly GrepDisplayLine[], limit: number): GrepDisplayLine[] {
	if (lines.length <= limit) return [...lines];
	if (limit <= 1) return lines.slice(0, 1);
	const selected = new Map<number, GrepDisplayLine>();
	for (let index = 0; index < limit; index += 1) {
		const line = lines[Math.round(index * (lines.length - 1) / (limit - 1))];
		if (line !== undefined) selected.set(line.line, line);
	}
	return [...selected.values()].sort((left, right) => left.line - right.line);
}

function createSuccess(
	input: GrepPackInput,
	totalCandidates: number,
	regions: readonly GrepRegion[],
	reasons: readonly TruncationReason[],
	droppedRelatedResults: number,
	ranking: GrepRankingDiagnostics,
): GrepSuccess {
	return {
		status: "success",
		query: input.query,
		path: input.path,
		...(input.paths === undefined ? {} : { paths: input.paths }),
		...(input.scopeErrors === undefined || input.scopeErrors.length === 0 ? {} : { scope_errors: input.scopeErrors }),
		total_candidates: totalCandidates,
		returned_regions: regions.length,
		returned_files: new Set(regions.map((region) => region.path)).size,
		approx_tokens: 0,
		stats: { ...input.stats, dropped_related_results: droppedRelatedResults },
		truncated_by: [...reasons],
		regions: [...regions],
		ranking,
	};
}

function rankingDiagnostics(
	allCandidates: readonly RankedRegion[],
	eligible: readonly RankedRegion[],
	selected: readonly RankedRegion[],
	limit: number,
): GrepRankingDiagnostics {
	const target = Math.min(limit, eligible.length);
	const headCount = Math.min(GREP_RELEVANCE_HEAD_SIZE, target);
	const relevanceRank = new Map(eligible.map((candidate, index) => [candidate.id, index + 1]));
	const baseline = eligible.slice(0, target);
	const baselineIds = new Set(baseline.map((candidate) => candidate.id));
	const regions: GrepRegionRanking[] = selected.map((candidate) => {
		const rank = relevanceRank.get(candidate.id) ?? Number.MAX_SAFE_INTEGER;
		return {
			relevance_rank: rank,
			tier: candidate.tier,
			primary_score: candidate.fieldScore,
			auxiliary_score: candidate.ranking.fusionScore,
			selection: rank <= headCount ? "head" : "mmr",
		};
	});
	const tiers = new Set(eligible.map((candidate) => candidate.tier));
	const topTier = eligible[0]?.tier;
	return {
		algorithm: GREP_RANKING_ALGORITHM,
		candidate_count: allCandidates.length,
		eligible_candidate_count: eligible.length,
		selected_candidate_count: selected.length,
		relevance_head_size: headCount,
		tier_count: tiers.size,
		top_tier_candidate_count: topTier === undefined
			? 0
			: eligible.filter((candidate) => candidate.tier === topTier).length,
		mmr_selected_count: regions.filter((region) => region.selection === "mmr").length,
		mmr_replacement_count: selected.filter((candidate) => !baselineIds.has(candidate.id)).length,
		relevance_prefix_file_count: uniqueFileCount(baseline),
		selected_file_count: uniqueFileCount(selected),
		regions,
	};
}

function uniqueFileCount(regions: readonly RankedRegion[]): number {
	return new Set(regions.map((region) => region.path)).size;
}

export function renderGrepSuccess(result: GrepSuccess): string {
	const lines = [grepOpenTag(result)];
	if (result.scope_errors !== undefined && result.scope_errors.length > 0) {
		const shown = result.scope_errors.slice(0, 2).map(({ path, error }) => `${compactPath(path)}:${error.code}`).join(",");
		const omitted = result.scope_errors.length - 2;
		lines.push(`partial; scope_errors=${shown}${omitted > 0 ? `,+${omitted}` : ""}`);
	}
	if (result.regions.length === 0) {
		lines.push("none");
	} else {
		appendRenderedRegions(lines, result.regions);
	}
	const omitted = Math.max(0, result.total_candidates - result.returned_regions);
	if (omitted > 0) lines.push(`+${omitted} lower-ranked omitted`);
	if (result.stats.skipped_files !== undefined) lines.push(`skipped: ${formatSkipped(result.stats.skipped_files)}`);
	if (result.regions.length === 0) {
		lines.push(`searched=${result.stats.searched_files}; skipped=${skippedCount(result.stats.skipped_files)}`);
		if (result.truncated_by.length > 0) lines.push(`next: resolve ${result.truncated_by.join(",")}; narrow path/glob`);
		else lines.push("next: refine query/path/glob");
	}
	lines.push("</grep>");
	return lines.join("\n");
}

function appendRenderedRegions(output: string[], regions: readonly GrepRegion[]): void {
	let index = 0;
	while (index < regions.length) {
		const region = regions[index];
		if (region === undefined) break;
		if (region.kind !== "text") {
			output.push(renderRegion(region));
			index += 1;
			continue;
		}
		const grouped = [region];
		let nextIndex = index + 1;
		while (nextIndex < regions.length) {
			const next = regions[nextIndex];
			if (next === undefined || !sameTextDisplayGroup(region, next)) break;
			grouped.push(next);
			nextIndex += 1;
		}
		output.push(grouped.length === 1 ? renderRegion(region) : renderTextRegionGroup(region, grouped));
		index = nextIndex;
	}
}

function sameTextDisplayGroup(left: GrepRegion, right: GrepRegion): boolean {
	return right.kind === "text"
		&& left.path === right.path
		&& left.query_match === right.query_match
		&& left.matched_by.join("\0") === right.matched_by.join("\0");
}

function renderTextRegionGroup(first: GrepRegion, regions: readonly GrepRegion[]): string {
	const related = first.query_match === "semantic" ? RELATED_MARKER : "";
	const lines = [`${first.path}${related}:`];
	for (const region of regions) {
		const display = region.display_lines?.[0];
		lines.push(display === undefined
			? `  ${region.start_line}:`
			: `  ${display.line}: ${display.text}`);
	}
	return lines.join("\n");
}

function renderRegion(region: GrepRegion): string {
	const displayLines = region.display_lines ?? [];
	if (region.kind === "text") {
		const display = displayLines[0];
		if (display === undefined) {
			const related = region.query_match === "semantic" ? RELATED_MARKER : "";
			return `${region.path}:${region.start_line}${related}:`;
		}
		return display.type === "match"
			? `${region.path}:${display.line}: ${display.text}`
			: `${region.path}:${display.line}${RELATED_MARKER}: ${display.text}`;
	}
	const range = `${region.path}:${region.start_line}${region.end_line === region.start_line ? "" : `-${region.end_line}`}`;
	const symbol = region.symbol === undefined ? "" : ` ${metadataValue(region.symbol)}`;
	const related = region.query_match === "semantic" ? RELATED_MARKER : "";
	const lines = [`${range}${symbol}${related}`];
	if (region.declaration !== undefined) lines.push(`  ${region.declaration}`);
	if (region.query_match === "verified") appendMatchingLines(lines, displayLines, region.match_lines?.length ?? 0);
	else appendEvidenceLines(lines, displayLines);
	return lines.join("\n");
}

function appendMatchingLines(output: string[], displayLines: readonly GrepDisplayLine[], total: number): void {
	const matches = displayLines.filter((line) => line.type === "match");
	for (const line of matches) output.push(`  ${line.line}: ${line.text}`);
	const omitted = Math.max(0, total - matches.length);
	if (omitted > 0) output.push(`  +${omitted} match lines`);
}

function appendEvidenceLines(output: string[], displayLines: readonly GrepDisplayLine[]): void {
	const evidence = displayLines.filter((line) => line.type === "evidence");
	for (const line of evidence) output.push(`  ${line.line}: ${line.text}`);
}

function orderedReasons(reasons: readonly TruncationReason[]): TruncationReason[] {
	const present = new Set(reasons);
	return TRUNCATION_ORDER.filter((reason) => present.has(reason));
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function isRetrievalSource(source: string): boolean {
	return source === "text-regex"
		|| source === "text-lexical";
}

function tokenCount(text: string): number {
	return countTextTokensSync(text).tokens;
}

function formatSkipped(skipped: GrepSkippedFiles): string {
	const parts: string[] = [];
	if (skipped.binary !== undefined) parts.push(`${skipped.binary} binary`);
	if (skipped.invalid_utf8 !== undefined) parts.push(`${skipped.invalid_utf8} invalid_utf8`);
	if (skipped.access_denied !== undefined) parts.push(`${skipped.access_denied} access_denied`);
	if (skipped.too_large !== undefined) parts.push(`${skipped.too_large} too_large`);
	if (skipped.changed !== undefined) parts.push(`${skipped.changed} changed`);
	return parts.join(", ");
}

function skippedCount(skipped: GrepSkippedFiles | undefined): number {
	return skipped === undefined ? 0 : Object.values(skipped).reduce((sum, count) => sum + (count ?? 0), 0);
}

function grepOpenTag(result: Pick<GrepSuccess, "truncated_by">): string {
	return result.truncated_by.length === 0 ? "<grep>" : `<grep truncated="${result.truncated_by.join(",")}">`;
}

function compactPath(value: string): string {
	const characters = [...value];
	if (characters.length <= 32) return value;
	return `...${characters.slice(-29).join("")}`;
}

function boundedDeclaration(value: string): string {
	const points = [...value];
	return points.length <= 240 ? value : `${points.slice(0, 237).join("")}...`;
}

function metadataValue(value: string): string {
	return value.replace(/[;\]\r\n]/gu, " ").trim();
}
