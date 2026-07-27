import { byteRangeForLines, extractByteRange } from "../../filesystem/services/text.js";
import { countTextTokensSync } from "../../token-counter.js";
import type { RankedRegion, TextHit } from "./candidates.js";
import type {
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

const MAX_MATCH_WINDOWS = 16;
const CANDIDATE_POOL_MIN = 32;
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
	sourceText: ReadonlyMap<string, string>;
	snippets: ReadonlyMap<string, string>;
	stats: GrepStats;
	truncationReasons: readonly TruncationReason[];
	tokenBudget: number;
	resultLimit: number;
	nearby: readonly GrepNearbyResult[];
	related: readonly GrepRelatedResult[];
}

interface RegionVariant {
	readonly region: GrepRegion;
}

interface CandidateChoice {
	readonly rank: number;
	readonly candidate: RankedRegion;
	readonly variants: readonly RegionVariant[];
	readonly minimumCost: number;
}

interface PackedChoice {
	readonly choice: CandidateChoice;
	variantIndex: number;
}

interface SelectionNode {
	readonly previous?: SelectionNode;
	readonly rank: number;
}

interface SelectionState {
	readonly score: number;
	readonly node?: SelectionNode;
}

/** 在精确 token 预算内优先保留首个高价值候选，再最大化条目数、相关性与展示完整度。 */
export function packGrepResults(input: GrepPackInput): GrepSuccess {
	const knownReasons = orderedReasons(input.truncationReasons);
	// 选择阶段预留两个可能出现的标签，最终协议只保留实际发生的原因。
	const assumedReasons = orderedReasons([...knownReasons, "result_limit", "token_budget"]);
	const choices = candidatePool(input);
	const packed = selectMainChoices(input, choices, assumedReasons);
	fillMainChoices(input, packed, choices, assumedReasons);
	upgradeMainChoices(input, packed, assumedReasons);
	const selectedRanks = new Set(packed.map((item) => item.choice.rank));
	const lastSelectedRank = Math.max(-1, ...selectedRanks);
	let tokenLimited = packed.length < Math.min(input.regions.length, input.resultLimit)
		|| packed.some((item) => item.variantIndex > 0)
		|| choices.some((choice) => choice.rank < lastSelectedRank && !selectedRanks.has(choice.rank));
	const regions = packed.map((item) => item.choice.variants[item.variantIndex]?.region).filter(isGrepRegion);
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
	for (const candidate of input.related) {
		if (usedCount >= input.resultLimit) break;
		if (fits(input, regions, nearby, [...related, candidate], assumedReasons)) {
			related.push(candidate);
			usedCount += 1;
		} else tokenLimited = true;
	}

	const eligibleCount = regions.length > 0
		? input.regions.length + input.related.length
		: input.nearby.length + input.related.length;
	const baseReasons = orderedReasons([
		...knownReasons,
		...(eligibleCount > input.resultLimit ? ["result_limit" as const] : []),
	]);
	const reasons = tokenLimited ? orderedReasons([...baseReasons, "token_budget"]) : baseReasons;
	const result = createSuccess(input, regions, nearby, related, reasons);
	return { ...result, approx_tokens: tokenCount(renderGrepSuccess(result)) };
}

function candidatePool(input: GrepPackInput): CandidateChoice[] {
	const minimums = input.regions.map((candidate, rank) => {
		const minimum = minimumVariant(candidate, input);
		return { rank, candidate, minimum, minimumCost: regionCost(minimum.region, input.match) };
	});
	const span = Math.max(CANDIDATE_POOL_MIN, input.resultLimit * 4);
	const selectedRanks = new Set(minimums.slice(0, span).map((item) => item.rank));
	for (const item of minimums.slice(span)
		.sort((left, right) => left.minimumCost - right.minimumCost || left.rank - right.rank)
		.slice(0, span)) selectedRanks.add(item.rank);
	return minimums
		.filter((item) => selectedRanks.has(item.rank))
		.sort((left, right) => left.rank - right.rank)
		.map((item) => {
			const variants = displayVariants(item.candidate, input);
			return { rank: item.rank, candidate: item.candidate, variants, minimumCost: regionCost(variants.at(-1)?.region ?? item.minimum.region, input.match) };
		});
}

function selectMainChoices(
	input: GrepPackInput,
	choices: readonly CandidateChoice[],
	reasons: readonly TruncationReason[],
): PackedChoice[] {
	if (input.resultLimit <= 0 || choices.length === 0) return [];
	const empty = createSuccess(input, [], [], [], reasons);
	const availableBudget = Math.max(0, input.tokenBudget - tokenCount(renderGrepSuccess(empty)));
	const first = choices[0];
	const mandatory = first !== undefined && first.minimumCost <= availableBudget ? first : undefined;
	const startCost = mandatory?.minimumCost ?? 0;
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
				const nextCost = cost + choice.minimumCost;
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

	let best: { readonly count: number; readonly cost: number; readonly state: SelectionState } | undefined;
	for (let count = input.resultLimit; count >= 0 && best === undefined; count -= 1) {
		for (const [cost, state] of states[count] ?? []) {
			if (best === undefined || state.score > best.state.score || (state.score === best.state.score && cost < best.cost)) {
				best = { count, cost, state };
			}
		}
	}
	const ranks = selectionRanks(best?.state.node);
	const byRank = new Map(choices.map((choice) => [choice.rank, choice]));
	const selected = ranks.flatMap((rank) => {
		const choice = byRank.get(rank);
		return choice === undefined ? [] : [{ choice, variantIndex: choice.variants.length - 1 }];
	}).sort((left, right) => left.choice.rank - right.choice.rank);

	while (selected.length > 0 && !fits(input, selectedRegions(selected), [], [], reasons)) {
		let removable = selected.length - 1;
		while (removable >= 0 && selected[removable]?.choice === mandatory) removable -= 1;
		if (removable >= 0) selected.splice(removable, 1);
		else selected.pop();
	}
	if (selected.length === 0) {
		for (const choice of choices) {
			const fallback: PackedChoice = { choice, variantIndex: choice.variants.length - 1 };
			if (fits(input, selectedRegions([fallback]), [], [], reasons)) return [fallback];
		}
	}
	return selected;
}

function fillMainChoices(
	input: GrepPackInput,
	selected: PackedChoice[],
	choices: readonly CandidateChoice[],
	reasons: readonly TruncationReason[],
): void {
	const selectedRanks = new Set(selected.map((item) => item.choice.rank));
	for (const choice of choices) {
		if (selected.length >= input.resultLimit) break;
		if (selectedRanks.has(choice.rank)) continue;
		const candidate: PackedChoice = { choice, variantIndex: choice.variants.length - 1 };
		const projected = [...selected, candidate].sort((left, right) => left.choice.rank - right.choice.rank);
		if (!fits(input, selectedRegions(projected), [], [], reasons)) continue;
		selected.push(candidate);
		selected.sort((left, right) => left.choice.rank - right.choice.rank);
		selectedRanks.add(choice.rank);
	}
}

function upgradeMainChoices(
	input: GrepPackInput,
	selected: PackedChoice[],
	reasons: readonly TruncationReason[],
): void {
	for (const item of selected) {
		for (let index = 0; index < item.variantIndex; index += 1) {
			const previous = item.variantIndex;
			item.variantIndex = index;
			if (fits(input, selectedRegions(selected), [], [], reasons)) break;
			item.variantIndex = previous;
		}
	}
}

function displayVariants(candidate: RankedRegion, input: GrepPackInput): RegionVariant[] {
	const base = publicRegionBase(candidate);
	const source = input.sourceText.get(candidate.path);
	const variants: RegionVariant[] = [];
	if (source !== undefined && candidate.kind !== "text") {
		const body = extractLineRange(source, candidate.startLine, candidate.endLine);
		if (body !== undefined && body.length > 0) variants.push({ region: { ...base, detail: "body", content: body } });
	}
	if (candidate.queryMatch === "verified" && source !== undefined) {
		for (const contextLines of [3, 1, 0]) {
			const snippet = sourceMatchWindow(candidate, source, contextLines, MAX_MATCH_WINDOWS);
			if (snippet !== undefined) variants.push({ region: withSnippet(base, snippet) });
		}
	} else {
		const stored = input.snippets.get(candidate.id) ?? verifiedContext(candidate);
		if (stored !== undefined && stored.length > 0) variants.push({
			region: { ...base, detail: "snippet", content: stored },
		});
		if (source !== undefined && candidate.queryMatch !== "verified") {
			const snippet = sourceStartWindow(candidate, source);
			if (snippet !== undefined) variants.push({ region: withSnippet(base, snippet) });
		}
	}
	variants.push(minimumVariant(candidate, input));
	return dedupeVariants(variants);
}

function minimumVariant(candidate: RankedRegion, input: GrepPackInput): RegionVariant {
	const base = publicRegionBase(candidate);
	if (candidate.queryMatch === "verified") {
		const source = input.sourceText.get(candidate.path);
		const snippet = source === undefined ? hitOnlyWindow(candidate.verifiedHits) : sourceMatchWindow(candidate, source, 0, 1);
		if (snippet !== undefined) return { region: withSnippet(base, snippet) };
		const content = verifiedContext(candidate) ?? input.snippets.get(candidate.id);
		if (content !== undefined) return { region: { ...base, detail: "snippet", content } };
	}
	return { region: { ...base, detail: "signature" } };
}

function publicRegionBase(candidate: RankedRegion): Omit<GrepRegion, "detail"> {
	return {
		path: candidate.path,
		start_line: candidate.startLine,
		end_line: candidate.endLine,
		kind: candidate.kind,
		...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
		...(candidate.signature === undefined ? {} : { signature: candidate.signature }),
		query_match: candidate.queryMatch === "verified" ? "verified" : "semantic",
		roles: unique(candidate.roles),
		reasons: unique(candidate.evidence.map((item) => item.reason)),
		sources: unique(candidate.evidence.map((item) => item.source)),
		...(candidate.matchLines.length === 0 ? {} : { match_lines: [...candidate.matchLines].sort((left, right) => left - right) }),
	};
}

function sourceMatchWindow(
	candidate: RankedRegion,
	source: string,
	contextLines: number,
	maxMatches: number,
): { readonly startLine: number; readonly endLine: number; readonly content: string } | undefined {
	const matches = representativeLines(candidate.matchLines, maxMatches);
	if (matches.length === 0) return undefined;
	const intervals = mergeIntervals(matches.map((line) => ({
		start: Math.max(candidate.startLine, line - contextLines),
		end: Math.min(candidate.endLine, line + contextLines),
	})));
	const chunks: string[] = [];
	let previous = candidate.startLine - 1;
	for (const interval of intervals) {
		const omitted = interval.start - previous - 1;
		if (omitted > 0) chunks.push(`[...] ${omitted} lines omitted [...]`);
		const content = extractLineRange(source, interval.start, interval.end);
		if (content === undefined) return undefined;
		chunks.push(content);
		previous = interval.end;
	}
	const tail = candidate.endLine - previous;
	if (tail > 0) chunks.push(`[...] ${tail} lines omitted [...]`);
	if (candidate.matchLines.length > matches.length) chunks.push(`[...] ${candidate.matchLines.length - matches.length} matching lines omitted [...]`);
	return { startLine: intervals[0]?.start ?? candidate.startLine, endLine: intervals.at(-1)?.end ?? candidate.endLine, content: chunks.join("\n") };
}

function sourceStartWindow(
	candidate: RankedRegion,
	source: string,
): { readonly startLine: number; readonly endLine: number; readonly content: string } | undefined {
	const endLine = Math.min(candidate.endLine, candidate.startLine + 6);
	const content = extractLineRange(source, candidate.startLine, endLine);
	if (content === undefined || content.length === 0) return undefined;
	return {
		startLine: candidate.startLine,
		endLine,
		content: `${content}${endLine < candidate.endLine ? `\n[...] ${candidate.endLine - endLine} lines omitted [...]` : ""}`,
	};
}

function extractLineRange(source: string, startLine: number, endLine: number): string | undefined {
	const range = byteRangeForLines(source, startLine, endLine);
	if (range === undefined) return undefined;
	return extractByteRange(source, range.startByte, range.endByte)?.replace(/\s+$/u, "");
}

function hitOnlyWindow(hits: readonly [TextHit, ...TextHit[]]): { readonly startLine: number; readonly endLine: number; readonly content: string } {
	const hit = [...hits].sort((left, right) => left.lineText.length - right.lineText.length || left.line - right.line)[0] ?? hits[0];
	return { startLine: hit.line, endLine: hit.line, content: hit.lineText };
}

function verifiedContext(candidate: RankedRegion): string | undefined {
	if (candidate.queryMatch !== "verified") return undefined;
	const hit = candidate.verifiedHits[0];
	return [...hit.before, hit.lineText, ...hit.after].join("\n");
}

function withSnippet(
	base: Omit<GrepRegion, "detail">,
	snippet: { readonly startLine: number; readonly endLine: number; readonly content: string },
): GrepRegion {
	return { ...base, start_line: snippet.startLine, end_line: snippet.endLine, detail: "snippet", content: snippet.content };
}

function representativeLines(lines: readonly number[], limit: number): number[] {
	const uniqueLines = unique(lines).sort((left, right) => left - right);
	if (uniqueLines.length <= limit) return uniqueLines;
	if (limit <= 1) return uniqueLines.slice(0, 1);
	const result = new Set<number>();
	for (let index = 0; index < limit; index += 1) {
		result.add(uniqueLines[Math.round(index * (uniqueLines.length - 1) / (limit - 1))] ?? uniqueLines[0] ?? 1);
	}
	return [...result].sort((left, right) => left - right);
}

function mergeIntervals(intervals: readonly { readonly start: number; readonly end: number }[]): Array<{ start: number; end: number }> {
	const result: Array<{ start: number; end: number }> = [];
	for (const interval of [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)) {
		const previous = result.at(-1);
		if (previous === undefined || interval.start > previous.end + 1) result.push({ ...interval });
		else previous.end = Math.max(previous.end, interval.end);
	}
	return result;
}

function dedupeVariants(variants: readonly RegionVariant[]): RegionVariant[] {
	const result: RegionVariant[] = [];
	const seen = new Set<string>();
	for (const variant of variants) {
		const key = `${variant.region.detail}\0${variant.region.content ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(variant);
	}
	return result;
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

function selectedRegions(selected: readonly PackedChoice[]): GrepRegion[] {
	return selected.flatMap((item) => {
		const region = item.choice.variants[item.variantIndex]?.region;
		return region === undefined ? [] : [region];
	});
}

function regionCost(region: GrepRegion, match: GrepMatchMode): number {
	return tokenCount(renderRegion(region, match)) + 1;
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
		for (const region of result.regions) lines.push(renderRegion(region, result.match));
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

function renderRegion(region: GrepRegion, match: GrepMatchMode): string {
	const headerSymbol = region.detail === "body"
		? region.symbol ?? region.signature
		: region.signature ?? region.symbol;
	const header = `${region.path}:${region.start_line}${region.end_line === region.start_line ? "" : `-${region.end_line}`}`;
	const reasons = visibleReasons(region.reasons, match);
	const subject = headerSymbol ?? region.kind;
	const label = reasons.length === 0 ? subject : `${subject} [${reasons.join(",")}]`;
	const lines = [`${header} ${label}`];
	if (region.content !== undefined) lines.push(region.content);
	return lines.join("\n");
}

function renderRelated(related: readonly GrepRelatedResult[]): string {
	const lines = ["<related nonmatch>"];
	for (const result of related) {
		const range = result.start_line === undefined
			? result.path
			: `${result.path}:${result.start_line}${result.end_line === undefined || result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
		lines.push(`${range} ${result.signature ?? result.symbol ?? result.kind} [${result.relations.join(",")}]`);
	}
	lines.push("</related>");
	return lines.join("\n");
}

function renderNearby(nearby: readonly GrepNearbyResult[]): string {
	const lines = ["<nearby nonmatch>"];
	for (const result of nearby) {
		const range = `${result.path}:${result.start_line}${result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
		lines.push(`${range} ${result.symbol ?? result.signature ?? result.kind} [${result.reason}]`);
	}
	lines.push("</nearby>");
	return lines.join("\n");
}

function visibleReasons(reasons: readonly string[], match: GrepMatchMode): string[] {
	return reasons.filter((reason) =>
		reason !== "hop 1"
		&& !(match === "literal" && reason === "exact literal")
		&& !(match === "regex" && reason === "regex"));
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

function isGrepRegion(value: GrepRegion | undefined): value is GrepRegion {
	return value !== undefined;
}
