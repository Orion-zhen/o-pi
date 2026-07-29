import { countTextTokensSync } from "../../token-counter.js";
import type { RankedRegion } from "./candidates.js";
import { selectRankedRegionsInOrder } from "./ranking.js";
import type {
	GrepDisplayLine,
	GrepMatchMode,
	GrepNearbyResult,
	GrepRegion,
	GrepRelatedResult,
	GrepScopeError,
	GrepSkippedFiles,
	GrepStats,
	GrepSuccess,
	TruncationReason,
} from "./types.js";

const CANDIDATE_POOL_MIN = 32;
const RELATION_ROLES = new Set(["caller", "callee", "reference", "test", "import", "registration", "entrypoint"]);
const TRUNCATION_ORDER: readonly TruncationReason[] = [
	"traversal_limit",
	"text_byte_limit",
	"semantic_candidate_limit",
	"result_limit",
	"token_budget",
];

export interface GrepPackInput {
	query: string;
	path: string;
	paths?: string[];
	scopeErrors?: GrepScopeError[];
	match: GrepMatchMode;
	totalCandidates: number;
	regions: readonly RankedRegion[];
	stats: GrepStats;
	truncationReasons: readonly TruncationReason[];
	tokenBudget: number;
	resultLimit: number;
	regionalDisplayLimit: number;
	relationActionLimit: number;
	nearby: readonly GrepNearbyResult[];
	related: readonly GrepRelatedResult[];
}

interface CandidateChoice {
	readonly rank: number;
	readonly region: GrepRegion;
	readonly cost: number;
}

interface SelectionNode {
	readonly previous?: SelectionNode;
	readonly rank: number;
}

interface SelectionState {
	readonly score: number;
	readonly node?: SelectionNode;
}

/** 每个候选只有一个固定表示；预算只决定保留哪些候选。 */
export function packGrepResults(input: GrepPackInput): GrepSuccess {
	const knownReasons = orderedReasons(input.truncationReasons);
	const assumedReasons = orderedReasons([...knownReasons, "result_limit", "token_budget"]);
	const diversified = diversifyCandidateOrder(input.regions, candidatePoolSpan(input.resultLimit));
	const eligibleRegions = limitRelationActions(diversified, input.relationActionLimit);
	const choices = candidatePool(input, eligibleRegions);
	const selected = selectMainChoices(input, choices, assumedReasons);
	const selectedRanks = new Set(selected.map((item) => item.rank));
	const lastSelectedRank = Math.max(-1, ...selectedRanks);
	let tokenLimited = selected.length < Math.min(eligibleRegions.length, input.resultLimit)
		|| choices.some((choice) => choice.rank < lastSelectedRank && !selectedRanks.has(choice.rank));
	const regions = selected.map((item) => item.region);
	const nearby: GrepNearbyResult[] = [];
	const related: GrepRelatedResult[] = [];
	let usedCount = regions.length;

	if (regions.length === 0) {
		for (const candidate of input.nearby) {
			if (usedCount >= input.resultLimit) break;
			if (fits(input, regions, [...nearby, candidate], related, assumedReasons)) {
				nearby.push(candidate);
				usedCount += 1;
			} else tokenLimited = true;
		}
	}
	const relationActionsUsed = regions.filter(isRelationAction).length;
	const relatedLimit = Math.max(0, input.relationActionLimit - relationActionsUsed);
	for (const candidate of input.related) {
		if (usedCount >= input.resultLimit || related.length >= relatedLimit) break;
		if (fits(input, regions, nearby, [...related, candidate], assumedReasons)) {
			related.push(candidate);
			usedCount += 1;
		} else tokenLimited = true;
	}

	const relationLimited = eligibleRegions.length < input.regions.length || input.related.length > relatedLimit;
	const eligibleCount = regions.length > 0
		? eligibleRegions.length + Math.min(input.related.length, relatedLimit)
		: input.nearby.length + Math.min(input.related.length, relatedLimit);
	const baseReasons = orderedReasons([
		...knownReasons,
		...(eligibleCount > input.resultLimit || relationLimited ? ["result_limit" as const] : []),
	]);
	const reasons = tokenLimited ? orderedReasons([...baseReasons, "token_budget"]) : baseReasons;
	const result = createSuccess(input, regions, nearby, related, reasons);
	return { ...result, approx_tokens: tokenCount(renderGrepSuccess(result)) };
}

function candidatePool(input: GrepPackInput, candidates: readonly RankedRegion[]): CandidateChoice[] {
	const choices = candidates.map((candidate, rank) => {
		const region = publicRegion(candidate, input.regionalDisplayLimit);
		return { rank, region, cost: regionCost(region) };
	});
	const span = candidatePoolSpan(input.resultLimit);
	const selectedRanks = new Set(choices.slice(0, span).map((item) => item.rank));
	for (const item of choices.slice(span)
		.sort((left, right) => left.cost - right.cost || left.rank - right.rank)
		.slice(0, span)) selectedRanks.add(item.rank);
	return choices.filter((item) => selectedRanks.has(item.rank)).sort((left, right) => left.rank - right.rank);
}

/** MMR 只重排 packer 会优先考虑的有界头部；尾部保留完整相关性顺序供低成本候选回退。 */
function diversifyCandidateOrder(candidates: readonly RankedRegion[], limit: number): RankedRegion[] {
	const selected = selectRankedRegionsInOrder(candidates, Math.min(limit, candidates.length));
	if (selected.length === candidates.length) return selected;
	const selectedIds = new Set(selected.map((candidate) => candidate.id));
	return [...selected, ...candidates.filter((candidate) => !selectedIds.has(candidate.id))];
}

function candidatePoolSpan(resultLimit: number): number {
	return Math.max(CANDIDATE_POOL_MIN, resultLimit * 4);
}

function limitRelationActions(candidates: readonly RankedRegion[], limit: number): RankedRegion[] {
	let used = 0;
	return candidates.filter((candidate) => {
		if (!isRelationAction(candidate)) return true;
		used += 1;
		return used <= limit;
	});
}

function isRelationAction(region: Pick<RankedRegion | GrepRegion, "roles">): boolean {
	return region.roles !== undefined && region.roles.length > 0 && region.roles.every((role) => RELATION_ROLES.has(role));
}

function selectMainChoices(
	input: GrepPackInput,
	choices: readonly CandidateChoice[],
	reasons: readonly TruncationReason[],
): CandidateChoice[] {
	if (input.resultLimit <= 0 || choices.length === 0) return [];
	const empty = createSuccess(input, [], [], [], reasons);
	const availableBudget = Math.max(0, input.tokenBudget - tokenCount(renderGrepSuccess(empty)));
	const first = choices[0];
	const mandatory = first !== undefined && first.cost <= availableBudget ? first : undefined;
	const startCost = mandatory?.cost ?? 0;
	const startCount = mandatory === undefined ? 0 : 1;
	const states = Array.from({ length: input.resultLimit + 1 }, () => new Map<number, SelectionState>());
	states[startCount]?.set(startCost, {
		score: mandatory === undefined ? 0 : choices.length + 1,
		...(mandatory === undefined ? {} : { node: { rank: mandatory.rank } }),
	});

	for (const [choiceIndex, choice] of choices.entries()) {
		if (choice === mandatory) continue;
		for (let count = input.resultLimit; count > startCount; count -= 1) {
			const previous = states[count - 1];
			const current = states[count];
			if (previous === undefined || current === undefined) continue;
			for (const [cost, state] of [...previous.entries()]) {
				const nextCost = cost + choice.cost;
				if (nextCost > availableBudget) continue;
				const score = state.score + choices.length - choiceIndex;
				const existing = current.get(nextCost);
				if (existing === undefined || score > existing.score) {
					current.set(nextCost, { score, node: { ...(state.node === undefined ? {} : { previous: state.node }), rank: choice.rank } });
				}
			}
		}
		if (choiceIndex % 8 === 7) for (const state of states) pruneDominatedStates(state);
	}

	let best: { readonly cost: number; readonly state: SelectionState } | undefined;
	for (let count = input.resultLimit; count >= 0 && best === undefined; count -= 1) {
		for (const [cost, state] of states[count] ?? []) {
			if (best === undefined || state.score > best.state.score || (state.score === best.state.score && cost < best.cost)) best = { cost, state };
		}
	}
	const byRank = new Map(choices.map((choice) => [choice.rank, choice]));
	const selected = selectionRanks(best?.state.node)
		.flatMap((rank) => {
			const choice = byRank.get(rank);
			return choice === undefined ? [] : [choice];
		})
		.sort((left, right) => left.rank - right.rank);

	while (selected.length > 0 && !fits(input, selected.map((item) => item.region), [], [], reasons)) {
		let removable = selected.length - 1;
		while (removable >= 0 && selected[removable] === mandatory) removable -= 1;
		if (removable >= 0) selected.splice(removable, 1);
		else selected.pop();
	}
	if (selected.length === 0) {
		for (const choice of choices) if (fits(input, [choice.region], [], [], reasons)) return [choice];
	}
	return selected;
}

function publicRegion(candidate: RankedRegion, displayLimit: number): GrepRegion {
	const displayLines = candidate.queryMatch === "verified"
		? representativeLines(candidate.displayLines, displayLimit)
		: candidate.displayLines.slice(0, displayLimit);
	return {
		path: candidate.path,
		start_line: candidate.startLine,
		end_line: candidate.endLine,
		kind: candidate.kind,
		...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
		...(candidate.declaration === undefined ? {} : { declaration: boundedDeclaration(candidate.declaration) }),
		query_match: candidate.queryMatch === "verified" ? "verified" : "semantic",
		roles: unique(candidate.roles),
		matched_by: [...candidate.matchedBy],
		sources: unique(candidate.evidence.map((item) => item.source)),
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

function pruneDominatedStates(states: Map<number, SelectionState>): void {
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const [cost, state] of [...states.entries()].sort((left, right) => left[0] - right[0])) {
		if (state.score <= bestScore) states.delete(cost);
		else bestScore = state.score;
	}
}

function selectionRanks(node: SelectionNode | undefined): number[] {
	const result: number[] = [];
	for (let current = node; current !== undefined; current = current.previous) result.push(current.rank);
	return result.reverse();
}

function regionCost(region: GrepRegion): number {
	return tokenCount(renderRegion(region)) + 1;
}

function fits(
	input: GrepPackInput,
	regions: readonly GrepRegion[],
	nearby: readonly GrepNearbyResult[],
	related: readonly GrepRelatedResult[],
	reasons: readonly TruncationReason[],
): boolean {
	return tokenCount(renderGrepSuccess(createSuccess(input, regions, nearby, related, reasons))) <= input.tokenBudget;
}

function createSuccess(
	input: GrepPackInput,
	regions: readonly GrepRegion[],
	nearby: readonly GrepNearbyResult[],
	related: readonly GrepRelatedResult[],
	reasons: readonly TruncationReason[],
): GrepSuccess {
	return {
		status: "success",
		query: input.query,
		path: input.path,
		...(input.paths === undefined ? {} : { paths: input.paths }),
		...(input.scopeErrors === undefined || input.scopeErrors.length === 0 ? {} : { scope_errors: input.scopeErrors }),
		match: input.match,
		total_candidates: input.totalCandidates,
		returned_regions: regions.length,
		returned_files: new Set(regions.map((region) => region.path)).size,
		approx_tokens: 0,
		stats: input.stats,
		truncated_by: [...reasons],
		regions: [...regions],
		...(nearby.length === 0 ? {} : { nearby: [...nearby] }),
		...(related.length === 0 ? {} : { related: [...related] }),
	};
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
		if (result.nearby !== undefined && result.nearby.length > 0) lines.push(renderNearby(result.nearby));
	} else {
		for (const region of result.regions) lines.push(renderRegion(region));
	}
	const omitted = Math.max(0, result.total_candidates - result.returned_regions);
	if (omitted > 0) lines.push(`+${omitted} lower-ranked omitted`);
	if (result.stats.skipped_files !== undefined) lines.push(`skipped: ${formatSkipped(result.stats.skipped_files)}`);
	if (result.related !== undefined && result.related.length > 0) lines.push(renderRelated(result.related));
	if (result.regions.length === 0 && result.nearby === undefined && result.related === undefined) {
		lines.push(`searched=${result.stats.searched_files}; skipped=${skippedCount(result.stats.skipped_files)}`);
		if (result.truncated_by.length > 0) lines.push(`next: resolve ${result.truncated_by.join(",")}; narrow path/glob`);
		else lines.push(result.match === "auto" ? "next: broaden query/path/glob" : "next: use match=auto or broaden path/glob");
	}
	lines.push("</grep>");
	return lines.join("\n");
}

function renderRegion(region: GrepRegion): string {
	const displayLines = region.display_lines ?? [];
	if (region.kind === "text") {
		const evidence = displayLines[0];
		if (evidence === undefined) return `${region.path}:${region.start_line}:`;
		return evidence.type === "match"
			? `${region.path}:${evidence.line}: ${evidence.text}`
			: `${region.path}:${evidence.line} [evidence=lexical]: ${evidence.text}`;
	}
	const range = `${region.path}:${region.start_line}-${region.end_line}`;
	const metadata = [
		`kind=${metadataValue(region.kind)}`,
		...(region.symbol === undefined ? [] : [`symbol=${metadataValue(region.symbol)}`]),
		...(region.roles === undefined || region.roles.length === 0 ? [] : [`roles=${region.roles.map(kebabCase).map(metadataValue).join(",")}`]),
		...(region.matched_by.length === 0 ? [] : [`matched-by=${region.matched_by.map(metadataValue).join(",")}`]),
	];
	const lines = [`${range} [${metadata.join("; ")}]`];
	if (region.declaration !== undefined) lines.push(`  declaration: ${region.declaration}`);
	if (region.query_match === "verified") appendMatchingLines(lines, displayLines, region.match_lines?.length ?? 0);
	else appendEvidenceLines(lines, displayLines);
	return lines.join("\n");
}

function appendMatchingLines(output: string[], displayLines: readonly GrepDisplayLine[], total: number): void {
	const matches = displayLines.filter((line) => line.type === "match");
	if (matches.length === 0) return;
	if (matches.length === 1 && total === 1) {
		const line = matches[0];
		if (line !== undefined) output.push(`  matching line ${line.line}: ${line.text}`);
		return;
	}
	output.push(`  matching lines (${matches.length} of ${total} shown):`);
	for (const line of matches) output.push(`    ${line.line}: ${line.text}`);
}

function appendEvidenceLines(output: string[], displayLines: readonly GrepDisplayLine[]): void {
	const evidence = displayLines.filter((line) => line.type === "evidence");
	if (evidence.length === 0) return;
	if (evidence.length === 1) {
		const line = evidence[0];
		if (line !== undefined) output.push(`  evidence line ${line.line}: ${line.text}`);
		return;
	}
	output.push(`  evidence lines (${evidence.length} shown):`);
	for (const line of evidence) output.push(`    ${line.line}: ${line.text}`);
}

function renderRelated(related: readonly GrepRelatedResult[]): string {
	const lines = ["<related query-match=\"not-guaranteed\">"];
	for (const result of related) {
		const range = result.start_line === undefined
			? result.path
			: `${result.path}:${result.start_line}${result.end_line === undefined || result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
		const metadata = [
			`kind=${metadataValue(result.kind)}`,
			...(result.symbol === undefined ? [] : [`symbol=${metadataValue(result.symbol)}`]),
			`relation=${result.relations.map(metadataValue).join(",")}`,
		];
		lines.push(`${range} [${metadata.join("; ")}]`);
	}
	lines.push("</related>");
	return lines.join("\n");
}

function renderNearby(nearby: readonly GrepNearbyResult[]): string {
	const lines = ["<nearby query-match=\"not-guaranteed\">"];
	for (const result of nearby) {
		const range = `${result.path}:${result.start_line}${result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
		const metadata = [
			`kind=${metadataValue(result.kind)}`,
			...(result.symbol === undefined ? [] : [`symbol=${metadataValue(result.symbol)}`]),
			`reason=${metadataValue(kebabCase(result.reason))}`,
		];
		lines.push(`${range} [${metadata.join("; ")}]`);
	}
	lines.push("</nearby>");
	return lines.join("\n");
}

function orderedReasons(reasons: readonly TruncationReason[]): TruncationReason[] {
	const present = new Set(reasons);
	return TRUNCATION_ORDER.filter((reason) => present.has(reason));
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
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

function kebabCase(value: string): string {
	return value.replaceAll("_", "-").replace(/\s+/gu, "-").toLocaleLowerCase();
}
