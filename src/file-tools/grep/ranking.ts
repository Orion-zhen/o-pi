import { tokenizeText } from "../../code-index/parser.js";
import {
	type CandidateSignal,
	type CodeRegion,
	type RankedRegion,
	type RegionEvidence,
	type RetrievalSource,
} from "./candidates.js";
import type { QueryPlan } from "./query-plan.js";
import type { GrepMatchedBy } from "./types.js";

export const GREP_RRF_K = 60;
export const GREP_RELEVANCE_HEAD_SIZE = 4;
export const GREP_MMR_LAMBDA = 0.85;
export const GREP_RANKING_ALGORITHM = "semantic-tier-bm25f-rrf-mmr-v2";

const SOURCE_WEIGHT: Readonly<Record<RetrievalSource, number>> = {
	"text-literal": 1,
	"text-regex": 1,
	"text-lexical": 0.75,
};

const TIER_POLICY: Readonly<Partial<Record<CandidateSignal, number>>> = {
	exact_qualified_definition: 1,
	exact_symbol_definition: 1,
	exact_member_definition: 2,
	symbol_prefix: 2,
	structured_symbol_match: 2,
	structured_path_match: 2,
	verified_enclosing_region: 3,
	verified_text_line: 4,
	lexical_high_coverage: 5,
	related_symbol: 6,
	lexical: 6,
};

const CANONICAL_SYMBOL_MATCH_SIGNALS = new Set<CandidateSignal>([
	"exact_qualified_definition",
	"exact_symbol_definition",
	"exact_member_definition",
	"symbol_prefix",
	"structured_symbol_match",
	"structured_path_match",
]);

type FieldName = "symbol" | "qualified" | "path" | "declaration" | "body";

interface FieldProfile {
	readonly terms: ReadonlyMap<string, number>;
	readonly length: number;
}

type RegionFieldProfile = Readonly<Record<FieldName, FieldProfile>>;

const FIELD_NAMES: readonly FieldName[] = ["symbol", "qualified", "path", "declaration", "body"];
const FIELD_WEIGHT: Readonly<Record<FieldName, number>> = {
	symbol: 8,
	qualified: 6,
	path: 5,
	declaration: 3,
	body: 1,
};
const FIELD_LENGTH_NORMALIZATION: Readonly<Record<FieldName, number>> = {
	symbol: 0,
	qualified: 0.2,
	path: 0.3,
	declaration: 0.5,
	body: 0.75,
};
const BM25_K1 = 1.2;
const FIELD_PROFILE_CACHE = new WeakMap<CodeRegion, RegionFieldProfile>();

/** 先按结构 tier 和 BM25F 相关性排序，来源分数只表达来源内局部 rank。 */
export function rankCodeRegions(plan: QueryPlan, regions: readonly CodeRegion[]): RankedRegion[] {
	const fieldScores = scoreFields(plan, regions);
	const structuredTerms = structuredQueryTerms(plan);
	const ranked: RankedRegion[] = [];
	for (const region of regions) {
		const signals = effectiveSignals(plan, region, structuredTerms);
		const queryTier = bestTier(signals);
		if (queryTier === undefined) continue;
		ranked.push({
			...region,
			signals,
			matchedBy: normalizeMatchedBy(signals, region.evidence),
			tier: structuralTier(queryTier, region),
			fieldScore: fieldScores.get(region) ?? 0,
			evidenceScore: scoreEvidence(region.evidence),
			verifiedCoverage: verifiedCoverage(region),
		});
	}
	return ranked.sort(compareRankedRegions);
}

export function compareRankedRegions(left: RankedRegion, right: RankedRegion): number {
	return left.tier - right.tier
		|| right.fieldScore - left.fieldScore
		|| right.evidenceScore - left.evidenceScore
		|| right.verifiedCoverage - left.verifiedCoverage
		|| regionSize(left) - regionSize(right)
		|| compareString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine
		|| compareString(left.id, right.id);
}

/** 输入已按相关性排序且 ID 唯一。保留头部，剩余名额只在最佳 tier 内执行 MMR。 */
export function selectRankedRegions(
	candidates: readonly RankedRegion[],
	limit: number,
): RankedRegion[] {
	if (limit <= 0 || candidates.length === 0) return [];
	const target = Math.min(limit, candidates.length);
	const headCount = Math.min(GREP_RELEVANCE_HEAD_SIZE, target);
	const selected = candidates.slice(0, headCount);
	const remaining = candidates.slice(headCount).map((candidate, index) => ({
		candidate,
		relevance: 1 - (index + headCount) / (candidates.length - 1),
		redundancy: 0,
		evaluated: 0,
	}));
	while (selected.length < target) {
		const first = remaining[0];
		if (first === undefined) break;
		let bestIndex = -1;
		let bestUtility = Number.NEGATIVE_INFINITY;
		for (const [index, item] of remaining.entries()) {
			if (item.candidate.tier !== first.candidate.tier) break;
			if (GREP_MMR_LAMBDA * item.relevance <= bestUtility) break;
			for (const chosen of selected.slice(item.evaluated)) {
				item.redundancy = Math.max(item.redundancy, regionSimilarity(item.candidate, chosen));
			}
			item.evaluated = selected.length;
			const utility = GREP_MMR_LAMBDA * item.relevance - (1 - GREP_MMR_LAMBDA) * item.redundancy;
			if (utility > bestUtility) {
				bestUtility = utility;
				bestIndex = index;
			}
		}
		const [chosen] = remaining.splice(bestIndex, 1);
		if (chosen === undefined) break;
		selected.push(chosen.candidate);
	}
	return [...selected.slice(0, headCount), ...selected.slice(headCount).sort(compareRankedRegions)];
}

function normalizeMatchedBy(signals: readonly CandidateSignal[], evidence: RegionEvidence | undefined): GrepMatchedBy[] {
	const signalSet = new Set(signals);
	const methods: GrepMatchedBy[] = [];
	if (signalSet.has("exact_qualified_definition")) methods.push("exact-qualified-symbol");
	if (signalSet.has("exact_symbol_definition") || signalSet.has("exact_member_definition")) methods.push("exact-symbol");
	if (signalSet.has("symbol_prefix")) methods.push("symbol-prefix");
	if (evidence?.source === "text-literal") methods.push("literal");
	if (evidence?.source === "text-regex") methods.push("regex");
	if (evidence?.source === "text-lexical") methods.push("lexical");
	if (signalSet.has("related_symbol")) methods.push("related");
	return methods;
}

function scoreEvidence(evidence: RegionEvidence | undefined): number {
	return evidence === undefined ? 0 : sourceContribution(evidence);
}

function sourceContribution(evidence: RegionEvidence): number {
	const rank = Math.max(1, Math.floor(evidence.rank));
	return SOURCE_WEIGHT[evidence.source] / (GREP_RRF_K + rank);
}

function effectiveSignals(
	plan: QueryPlan,
	region: CodeRegion,
	structuredTerms: readonly string[],
): CandidateSignal[] {
	const claimed = region.signals.filter((signal) => !CANONICAL_SYMBOL_MATCH_SIGNALS.has(signal));
	const derived: CandidateSignal[] = [];
	const symbolMatch = classifySymbolMatch(plan, region.symbol, region.qualifiedSymbol);
	if (region.symbolRole === "definition" && symbolMatch !== undefined) derived.push(symbolMatch);
	if (structuredTerms.length > 0) {
		const profile = fieldProfile(region);
		if (fieldsContainAll(profile, ["symbol", "qualified"], structuredTerms)) derived.push("structured_symbol_match");
		if (fieldsContainAll(profile, ["path"], structuredTerms)) derived.push("structured_path_match");
	}
	return [...new Set([...claimed, ...derived])];
}

/** 只对无正则操作符的名称或路径查询推导 symbol match。 */
export function classifySymbolMatch(
	plan: QueryPlan,
	symbol: string | undefined,
	qualifiedSymbol: string | undefined,
): Extract<CandidateSignal, "exact_qualified_definition" | "exact_symbol_definition" | "exact_member_definition" | "symbol_prefix"> | undefined {
	const target = normalizeSymbol(plan.structuredQuery ?? "");
	if (target.length === 0) return undefined;
	const full = normalizeSymbol(qualifiedSymbol ?? symbol ?? "");
	const leaf = normalizeSymbol(symbol === undefined ? lastSymbolSegment(full) : lastSymbolSegment(symbol));
	if (full.length === 0 || leaf.length === 0) return undefined;
	if (target.includes(".")) {
		if (full === target) return "exact_qualified_definition";
		if (leaf === lastSymbolSegment(target)) return "exact_member_definition";
		return undefined;
	}
	if (leaf === target) return "exact_symbol_definition";
	if (target.length >= 2 && leaf.startsWith(target)) return "symbol_prefix";
	return undefined;
}

function scoreFields(plan: QueryPlan, regions: readonly CodeRegion[]): ReadonlyMap<CodeRegion, number> {
	const queryTerms = [...tokenizeText(plan.targetTerms.join(" ")).keys()];
	if (queryTerms.length === 0 || regions.length === 0) return new Map();
	const profiles = regions.map((region) => ({ region, profile: fieldProfile(region) }));
	const averageLength = Object.fromEntries(FIELD_NAMES.map((field) => [
		field,
		profiles.reduce((sum, item) => sum + item.profile[field].length, 0) / profiles.length,
	])) as Record<FieldName, number>;
	const documentFrequency = new Map(queryTerms.map((term) => [
		term,
		profiles.filter((item) => FIELD_NAMES.some((field) => item.profile[field].terms.has(term))).length,
	]));
	const result = new Map<CodeRegion, number>();
	for (const item of profiles) {
		let score = 0;
		for (const term of queryTerms) {
			let weightedFrequency = 0;
			for (const field of FIELD_NAMES) {
				const value = item.profile[field];
				const frequency = value.terms.get(term) ?? 0;
				if (frequency === 0) continue;
				const average = Math.max(1, averageLength[field]);
				const b = FIELD_LENGTH_NORMALIZATION[field];
				weightedFrequency += FIELD_WEIGHT[field] * frequency
					/ (1 - b + b * value.length / average);
			}
			if (weightedFrequency === 0) continue;
			const frequency = documentFrequency.get(term) ?? 0;
			const inverseDocumentFrequency = Math.log(1 + (regions.length - frequency + 0.5) / (frequency + 0.5));
			score += inverseDocumentFrequency * (BM25_K1 + 1) * weightedFrequency / (BM25_K1 + weightedFrequency);
		}
		result.set(item.region, score);
	}
	return result;
}

function fieldProfile(region: CodeRegion): RegionFieldProfile {
	const cached = FIELD_PROFILE_CACHE.get(region);
	if (cached !== undefined) return cached;
	const fullSymbol = region.qualifiedSymbol ?? region.symbol ?? "";
	const body = region.queryMatch === "verified"
		? region.verifiedHits.map((hit) => hit.lineText).join("\n")
		: region.displayLines.map((line) => line.text).join("\n");
	const values: Readonly<Record<FieldName, string>> = {
		symbol: lastSymbolSegment(region.symbol ?? fullSymbol),
		qualified: fullSymbol,
		path: region.path,
		declaration: region.declaration ?? "",
		body,
	};
	const profile: RegionFieldProfile = {
		symbol: createFieldProfile(values.symbol),
		qualified: createFieldProfile(values.qualified),
		path: createFieldProfile(values.path),
		declaration: createFieldProfile(values.declaration),
		body: createFieldProfile(values.body),
	};
	FIELD_PROFILE_CACHE.set(region, profile);
	return profile;
}

function createFieldProfile(value: string): FieldProfile {
	const terms = tokenizeText(value);
	return {
		terms,
		length: [...terms.values()].reduce((sum, count) => sum + count, 0),
	};
}

function structuredQueryTerms(plan: QueryPlan): string[] {
	return plan.structuredQuery === undefined ? [] : [...tokenizeText(plan.structuredQuery).keys()];
}

function fieldsContainAll(
	profile: RegionFieldProfile,
	fields: readonly FieldName[],
	terms: readonly string[],
): boolean {
	return terms.every((term) => fields.some((field) => profile[field].terms.has(term)));
}

function bestTier(signals: readonly CandidateSignal[]): number | undefined {
	let best: number | undefined;
	for (const signal of signals) {
		const tier = TIER_POLICY[signal];
		if (tier !== undefined && (best === undefined || tier < best)) best = tier;
	}
	return best;
}

function verifiedCoverage(region: CodeRegion): number {
	if (region.queryMatch !== "verified") return 0;
	return region.matchLines.length / Math.max(1, region.endLine - region.startLine + 1);
}

function structuralTier(queryTier: number, region: CodeRegion): number {
	const authorityTier = region.authority === "called"
		? 0
		: region.authority === "referenced"
			? 1
			: region.authority === "defined"
				? 2
				: 3;
	return (queryTier - 1) * 4 + authorityTier + 1;
}

function regionSimilarity(left: RankedRegion, right: RankedRegion): number {
	if (left.id === right.id) return 1;
	if (left.path === right.path) return 1;
	const leftSymbol = normalizeSymbol(left.qualifiedSymbol ?? left.symbol ?? "");
	const rightSymbol = normalizeSymbol(right.qualifiedSymbol ?? right.symbol ?? "");
	if (leftSymbol.length > 0 && leftSymbol === rightSymbol) return 0.8;
	if (directoryOf(left.path) === directoryOf(right.path)) return 0.25;
	return topComponent(left.path) === topComponent(right.path) ? 0.08 : 0;
}

function regionSize(region: RankedRegion): number {
	return Math.max(1, region.endLine - region.startLine + 1);
}

function directoryOf(value: string): string {
	const slash = value.lastIndexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function topComponent(value: string): string {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function normalizeSymbol(value: string): string {
	return value.trim().replace(/::|#/gu, ".").toLocaleLowerCase();
}

function lastSymbolSegment(value: string): string {
	return value.split(/[.:#]/u).at(-1) ?? value;
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
