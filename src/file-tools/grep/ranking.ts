import {
	normalizeMatchedBy,
	type CandidateRole,
	type CandidateSignal,
	type CodeRegion,
	type RankedRegion,
	type RankingEvidenceSummary,
	type RegionEvidence,
	type RetrievalSource,
} from "./candidates.js";
import type { QueryPlan, RelationIntent } from "./query-plan.js";

export type RankingEvidenceFamily = "factual" | "symbol" | "lexical" | "semantic" | "graph";
export type RankingPolicyKey = "strict" | "identifier" | "qualified_symbol" | "long_text" | "natural_language" | "relation";

export const GREP_RRF_K = 60;
export const GREP_RELEVANCE_HEAD_SIZE = 3;
export const GREP_MMR_LAMBDA = 0.85;
export const GREP_SIMILARITY_WINDOW = 256;
export const GREP_TEST_CONTEXT_TIER_PENALTY = 3;

export const GREP_SOURCE_FAMILY: Readonly<Record<RetrievalSource, RankingEvidenceFamily>> = {
	"text-literal": "factual",
	"text-regex": "factual",
	"text-lexical": "lexical",
	"ast-symbol": "symbol",
	"ast-lexical": "lexical",
	"ast-relation": "graph",
	"lsp-symbol": "semantic",
	"lsp-reference": "semantic",
	"repo-map-direct": "semantic",
	"repo-map-hop-1": "graph",
};

/** 查询形态的相对权重只在此表中校准。 */
export const GREP_SOURCE_WEIGHTS: Readonly<Record<RankingPolicyKey, Readonly<Record<RetrievalSource, number>>>> = {
	strict: weights({ "text-literal": 1.5, "text-regex": 1.5, "ast-symbol": 0.45 }),
	identifier: weights({ "text-literal": 1.05, "text-lexical": 0.5, "ast-symbol": 1.35, "ast-lexical": 0.55, "ast-relation": 0.25, "lsp-symbol": 1.15, "repo-map-direct": 0.9 }),
	qualified_symbol: weights({ "text-literal": 1.1, "text-lexical": 0.45, "ast-symbol": 1.5, "ast-lexical": 0.45, "ast-relation": 0.35, "lsp-symbol": 1.25, "repo-map-direct": 1 }),
	long_text: weights({ "text-literal": 1.6, "text-lexical": 0.8, "ast-symbol": 0.35, "ast-lexical": 0.8 }),
	natural_language: weights({ "text-literal": 0.8, "text-lexical": 1.2, "ast-symbol": 0.65, "ast-lexical": 1.25, "ast-relation": 0.35, "repo-map-direct": 1.1 }),
	relation: weights({ "text-literal": 0.75, "text-lexical": 0.4, "ast-symbol": 0.8, "ast-lexical": 0.4, "ast-relation": 1.3, "lsp-symbol": 0.8, "lsp-reference": 1.35, "repo-map-direct": 0.9, "repo-map-hop-1": 1.15 }),
};

const TIER_POLICY: Readonly<Record<RankingPolicyKey, Readonly<Partial<Record<CandidateSignal, number>>>>> = {
	strict: {
		exact_qualified_definition: 1,
		exact_symbol_definition: 1,
		exact_member_definition: 1,
		verified_enclosing_region: 2,
		verified_phrase: 2,
		verified_text: 2,
		verified_qualified_occurrence: 2,
		verified_text_line: 3,
	},
	identifier: {
		exact_symbol_definition: 1,
		verified_phrase: 2,
		verified_text: 2,
		verified_enclosing_region: 2,
		direct_symbol: 3,
		symbol_prefix: 4,
		partial_symbol: 4,
		lexical_high_coverage: 5,
		lexical: 6,
	},
	qualified_symbol: {
		exact_qualified_definition: 1,
		exact_member_definition: 2,
		exact_symbol_definition: 2,
		verified_qualified_occurrence: 3,
		verified_phrase: 3,
		verified_text: 3,
		direct_symbol: 4,
		partial_symbol: 5,
		symbol_prefix: 5,
		lexical_high_coverage: 6,
		lexical: 7,
	},
	long_text: {
		verified_phrase: 1,
		verified_text: 1,
		verified_enclosing_region: 2,
		verified_text_line: 2,
		lexical_high_coverage: 3,
		multiview_consensus: 3,
		lexical: 4,
	},
	natural_language: {
		verified_phrase: 1,
		verified_text: 1,
		lexical_high_coverage: 2,
		multiview_consensus: 3,
		direct_symbol: 4,
		lexical: 5,
	},
	relation: {
		requested_relation: 1,
		target_definition: 2,
		exact_qualified_definition: 2,
		exact_symbol_definition: 2,
		target_occurrence: 3,
		verified_text: 3,
		lexical_high_coverage: 5,
		lexical: 6,
	},
};

const FACTUAL_SIGNALS = new Set<CandidateSignal>([
	"verified_phrase", "verified_text", "verified_qualified_occurrence", "verified_enclosing_region", "verified_text_line",
]);
const SYMBOL_SIGNALS = new Set<CandidateSignal>([
	"exact_qualified_definition", "exact_symbol_definition", "exact_member_definition", "direct_symbol", "symbol_prefix", "partial_symbol", "target_definition",
]);
const CANONICAL_SYMBOL_MATCH_SIGNALS = new Set<CandidateSignal>([
	"exact_qualified_definition", "exact_symbol_definition", "exact_member_definition", "symbol_prefix",
]);
const LEXICAL_SIGNALS = new Set<CandidateSignal>(["lexical_high_coverage", "lexical"]);
const RELATION_ROLES = new Set<CandidateRole>(["caller", "callee", "reference", "test", "import", "registration", "entrypoint"]);
const ROLE_BY_INTENT: Readonly<Record<RelationIntent, CandidateRole>> = {
	caller: "caller",
	callee: "callee",
	reference: "reference",
	test: "test",
	import: "import",
	registration: "registration",
	entrypoint: "entrypoint",
};
const EMPTY_RANKING: RankingEvidenceSummary = {
	factual: 0,
	symbol: 0,
	lexical: 0,
	semantic: 0,
	graph: 0,
	familyCount: 0,
	fusionScore: 0,
	bestContribution: 0,
};

/** 为每个独立来源生成从 1 开始的稳定局部名次。 */
export function assignSourceLocalRanks<T>(
	candidates: readonly T[],
	sourceOf: (candidate: T) => RetrievalSource,
	compareWithinSource: (left: T, right: T) => number,
): ReadonlyMap<T, number> {
	const grouped = new Map<RetrievalSource, T[]>();
	for (const candidate of candidates) {
		const source = sourceOf(candidate);
		const values = grouped.get(source);
		if (values === undefined) grouped.set(source, [candidate]);
		else values.push(candidate);
	}
	const result = new Map<T, number>();
	for (const source of [...grouped.keys()].sort(compareString)) {
		const values = grouped.get(source) ?? [];
		values.sort(compareWithinSource);
		for (const [index, candidate] of values.entries()) result.set(candidate, index + 1);
	}
	return result;
}

/** 对已准入区域执行纯排序；path-only 和 lane 非 main 候选不会进入主结果。 */
export function rankCodeRegions(plan: QueryPlan, regions: readonly CodeRegion[]): RankedRegion[] {
	const policy = rankingPolicyFor(plan);
	const ranked: RankedRegion[] = [];
	for (const region of regions) {
		if (!isMainEligible(plan, region)) continue;
		const evidence = canonicalEvidence(region.evidence);
		const signals = effectiveSignals(plan, { ...region, evidence });
		const baseTier = bestTier(policy, signals);
		if (baseTier === undefined) continue;
		ranked.push({
			...region,
			signals,
			evidence,
			matchedBy: normalizeMatchedBy(signals, evidence),
			tier: contextAdjustedTier(plan, baseTier, region.roles),
			ranking: summarizeEvidence(policy, independentRankingEvidence(plan, signals, evidence)),
			verifiedCoverage: verifiedCoverage(region),
			contextPriority: contextPriority(plan, region.roles),
			rolePriority: rolePriority(plan, region.roles),
		});
	}
	return ranked.sort(compareRankedRegions);
}

export function rankingPolicyFor(plan: QueryPlan): RankingPolicyKey {
	if (plan.match !== "auto") return "strict";
	if (plan.relationIntents.length > 0) return "relation";
	return plan.shape;
}

export function compareRankedRegions(left: RankedRegion, right: RankedRegion): number {
	return left.tier - right.tier
		|| right.contextPriority - left.contextPriority
		|| right.ranking.fusionScore - left.ranking.fusionScore
		|| right.verifiedCoverage - left.verifiedCoverage
		|| right.rolePriority - left.rolePriority
		|| regionSize(left) - regionSize(right)
		|| compareString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine
		|| compareString(left.id, right.id);
}

/** relevance head 原样保留，尾部只从当前最佳 tier 的有界窗口执行 MMR。 */
export function selectRankedRegions(
	candidates: readonly RankedRegion[],
	limit: number,
	headSize = GREP_RELEVANCE_HEAD_SIZE,
	similarityWindow = GREP_SIMILARITY_WINDOW,
): RankedRegion[] {
	if (limit <= 0 || candidates.length === 0) return [];
	const ranked = deduplicateRanked(candidates);
	return selectRankedInOrder(ranked, limit, headSize, similarityWindow);
}

/** 上游已完成稳定排名时保留其顺序，只在当前顺序内执行有界 MMR。 */
export function selectRankedRegionsInOrder(
	candidates: readonly RankedRegion[],
	limit: number,
	headSize = GREP_RELEVANCE_HEAD_SIZE,
	similarityWindow = GREP_SIMILARITY_WINDOW,
): RankedRegion[] {
	if (limit <= 0 || candidates.length === 0) return [];
	return selectRankedInOrder(deduplicateRankedInOrder(candidates), limit, headSize, similarityWindow);
}

function selectRankedInOrder(
	ranked: readonly RankedRegion[],
	limit: number,
	headSize: number,
	similarityWindow: number,
): RankedRegion[] {
	const target = Math.min(limit, ranked.length);
	const headCount = Math.min(Math.max(0, headSize), target);
	const selected = ranked.slice(0, headCount);
	const remaining = ranked.slice(headCount);
	const relevance = new Map(ranked.map((candidate, index) => [candidate, 1 - index / Math.max(1, ranked.length - 1)]));
	while (selected.length < target && remaining.length > 0) {
		const bestTier = remaining[0]?.tier;
		if (bestTier === undefined) break;
		let tierEnd = 0;
		while (remaining[tierEnd]?.tier === bestTier) tierEnd += 1;
		const evaluated = Math.min(tierEnd, Math.max(1, similarityWindow));
		let bestIndex = 0;
		let bestUtility = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < evaluated; index += 1) {
			const candidate = remaining[index];
			if (candidate === undefined) continue;
			const candidateRelevance = relevance.get(candidate) ?? 0;
			const redundancy = selected.reduce((maximum, chosen) => Math.max(maximum, similarity(candidate, chosen)), 0);
			const utility = GREP_MMR_LAMBDA * candidateRelevance - (1 - GREP_MMR_LAMBDA) * redundancy;
			if (utility > bestUtility) {
				bestUtility = utility;
				bestIndex = index;
			}
		}
		const [next] = remaining.splice(bestIndex, 1);
		if (next !== undefined) selected.push(next);
	}
	return selected;
}

export function summarizeEvidence(policy: RankingPolicyKey, evidence: readonly RegionEvidence[]): RankingEvidenceSummary {
	if (evidence.length === 0) return EMPTY_RANKING;
	const strongest: Record<RankingEvidenceFamily, number> = { factual: 0, symbol: 0, lexical: 0, semantic: 0, graph: 0 };
	for (const item of evidence) {
		const family = GREP_SOURCE_FAMILY[item.source];
		const contribution = sourceContribution(policy, item);
		if (contribution > strongest[family]) strongest[family] = contribution;
	}
	const values = Object.values(strongest);
	return {
		...strongest,
		familyCount: values.filter((value) => value > 0).length,
		fusionScore: values.reduce((sum, value) => sum + value, 0),
		bestContribution: Math.max(...values),
	};
}

export function sourceContribution(policy: RankingPolicyKey, evidence: RegionEvidence): number {
	const rank = Math.max(1, Math.floor(evidence.rank));
	const confidence = clamp(evidence.confidence, 0, 1);
	const hopFactor = evidence.hop === 1 ? 0.7 : 1;
	return GREP_SOURCE_WEIGHTS[policy][evidence.source] * confidence * hopFactor / (GREP_RRF_K + rank);
}

function weights(overrides: Partial<Record<RetrievalSource, number>>): Readonly<Record<RetrievalSource, number>> {
	return {
		"text-literal": 0,
		"text-regex": 0,
		"text-lexical": 0,
		"ast-symbol": 0,
		"ast-lexical": 0,
		"ast-relation": 0,
		"lsp-symbol": 0,
		"lsp-reference": 0,
		"repo-map-direct": 0,
		"repo-map-hop-1": 0,
		...overrides,
	};
}

function effectiveSignals(plan: QueryPlan, region: CodeRegion): CandidateSignal[] {
	const claimed = region.signals.filter((signal) => !CANONICAL_SYMBOL_MATCH_SIGNALS.has(signal));
	const candidates = [...claimed, ...derivedSignals(plan, region)];
	return [...new Set(candidates)].filter((signal) => signalSupported(plan, region, signal));
}

function derivedSignals(plan: QueryPlan, region: CodeRegion): CandidateSignal[] {
	const result: CandidateSignal[] = [];
	const symbolMatch = classifySymbolMatch(plan, region.symbol, region.qualifiedSymbol);
	if (region.roles.includes("definition") && symbolMatch !== undefined) result.push(symbolMatch);
	if (plan.relationIntents.length > 0 && region.roles.includes("definition") && isExactSymbolMatch(symbolMatch)) {
		result.push("target_definition");
	}
	if (plan.relationIntents.length > 0 && region.queryMatch === "verified") result.push("target_occurrence");
	if (summarizeFamilies(region.evidence) >= 2) result.push("multiview_consensus");
	return result;
}

/** 只根据规范化查询与候选名称判定 symbol match，来源不能自行提升 exact tier。 */
export function classifySymbolMatch(
	plan: QueryPlan,
	symbol: string | undefined,
	qualifiedSymbol: string | undefined,
): Extract<CandidateSignal, "exact_qualified_definition" | "exact_symbol_definition" | "exact_member_definition" | "symbol_prefix"> | undefined {
	const target = normalizeSymbol(plan.targetQuery.length > 0 ? plan.targetQuery : plan.query);
	if (target.length === 0 || target.includes(" ")) return undefined;
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

function signalSupported(plan: QueryPlan, region: CodeRegion, signal: CandidateSignal): boolean {
	const sources = new Set(region.evidence.map((item) => item.source));
	if (FACTUAL_SIGNALS.has(signal)) return region.queryMatch === "verified" && hasFamily(region, "factual");
	if (SYMBOL_SIGNALS.has(signal)) {
		if (!region.roles.includes("definition")) return false;
		return hasAnySource(sources, ["ast-symbol", "lsp-symbol", "repo-map-direct"])
			|| (region.queryMatch === "verified" && hasFamily(region, "factual") && region.symbol !== undefined);
	}
	if (LEXICAL_SIGNALS.has(signal)) return hasAnySource(sources, ["text-lexical", "ast-lexical"]);
	if (signal === "multiview_consensus") return summarizeFamilies(region.evidence) >= 2;
	if (signal === "requested_relation") {
		const requested = new Set(plan.relationIntents.map((intent) => ROLE_BY_INTENT[intent]));
		return region.roles.some((role) => requested.has(role))
			&& hasAnySource(sources, ["ast-relation", "lsp-reference", "repo-map-direct", "repo-map-hop-1"]);
	}
	if (signal === "target_occurrence") return region.queryMatch === "verified" || region.roles.includes("occurrence") || region.roles.includes("reference");
	return true;
}

function bestTier(policy: RankingPolicyKey, signals: readonly CandidateSignal[]): number | undefined {
	let best: number | undefined;
	for (const signal of signals) {
		const tier = TIER_POLICY[policy][signal];
		if (tier !== undefined && (best === undefined || tier < best)) best = tier;
	}
	return best;
}

function isMainEligible(plan: QueryPlan, region: CodeRegion): boolean {
	if (region.signals.length === 0) return false;
	if (plan.match !== "auto") return region.queryMatch === "verified";
	if (plan.relationIntents.length > 0) return true;
	const relationOnly = region.roles.length > 0 && region.roles.every((role) => RELATION_ROLES.has(role));
	if (!relationOnly) return true;
	return plan.shape === "qualified_symbol" && region.roles.every((role) => role === "reference");
}

function canonicalEvidence(evidence: readonly RegionEvidence[]): RegionEvidence[] {
	const strongest = new Map<string, RegionEvidence>();
	for (const item of evidence) {
		const key = `${item.source}\0${item.reason}`;
		const current = strongest.get(key);
		if (current === undefined || compareEvidence(item, current) < 0) strongest.set(key, item);
	}
	return [...strongest.values()].sort(compareEvidence);
}

function compareEvidence(left: RegionEvidence, right: RegionEvidence): number {
	return compareString(left.source, right.source)
		|| left.rank - right.rank
		|| right.confidence - left.confidence
		|| (left.hop ?? 0) - (right.hop ?? 0)
		|| compareString(left.reason, right.reason);
}

function deduplicateRanked(candidates: readonly RankedRegion[]): RankedRegion[] {
	const best = new Map<string, RankedRegion>();
	for (const candidate of candidates) {
		const prior = best.get(candidate.id);
		if (prior === undefined || compareRankedRegions(candidate, prior) < 0) best.set(candidate.id, candidate);
	}
	return [...best.values()].sort(compareRankedRegions);
}

function deduplicateRankedInOrder(candidates: readonly RankedRegion[]): RankedRegion[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		if (seen.has(candidate.id)) return false;
		seen.add(candidate.id);
		return true;
	});
}

function verifiedCoverage(region: CodeRegion): number {
	if (region.queryMatch !== "verified") return 0;
	return region.matchLines.length / Math.max(1, region.endLine - region.startLine + 1);
}

function contextAdjustedTier(plan: QueryPlan, tier: number, roles: readonly CandidateRole[]): number {
	if (plan.match !== "auto" || plan.relationIntents.length > 0) return tier;
	if ((plan.shape === "identifier" || plan.shape === "qualified_symbol") && roles.includes("test")) {
		return tier + GREP_TEST_CONTEXT_TIER_PENALTY;
	}
	return tier;
}

function contextPriority(plan: QueryPlan, roles: readonly CandidateRole[]): number {
	if (plan.match !== "auto") return 0;
	if (hasRequestedRole(plan, roles)) return 4;
	if (plan.relationIntents.length === 0 && roles.includes("test")) return 0;
	if (roles.includes("public_api")) return 3;
	if (roles.includes("definition")) return 2;
	if (roles.includes("occurrence") || roles.includes("text")) return 1;
	return 0;
}

function rolePriority(plan: QueryPlan, roles: readonly CandidateRole[]): number {
	if (hasRequestedRole(plan, roles)) return 3;
	if (roles.includes("definition") || roles.includes("public_api")) return 2;
	if (roles.includes("occurrence") || roles.includes("text")) return 1;
	return 0;
}

function hasRequestedRole(plan: QueryPlan, roles: readonly CandidateRole[]): boolean {
	return plan.relationIntents.some((intent) => roles.includes(ROLE_BY_INTENT[intent]));
}

function independentRankingEvidence(
	plan: QueryPlan,
	signals: readonly CandidateSignal[],
	evidence: readonly RegionEvidence[],
): readonly RegionEvidence[] {
	if (plan.match !== "auto" || plan.targetTerms.length !== 1 || !signals.some(isExactSymbolMatch)) return evidence;
	return evidence.filter((item) => item.source !== "ast-lexical" && item.source !== "text-lexical");
}

function isExactSymbolMatch(signal: CandidateSignal | undefined): boolean {
	return signal === "exact_qualified_definition" || signal === "exact_symbol_definition" || signal === "exact_member_definition";
}

function similarity(left: RankedRegion, right: RankedRegion): number {
	const samePath = left.path === right.path;
	const leftSymbol = normalizeSymbol(left.qualifiedSymbol ?? left.symbol ?? "");
	const rightSymbol = normalizeSymbol(right.qualifiedSymbol ?? right.symbol ?? "");
	if (samePath && leftSymbol.length > 0 && leftSymbol === rightSymbol) return 1;
	if (samePath && rangesOverlap(left, right)) return 0.95;
	if (leftSymbol.length > 0 && leftSymbol === rightSymbol) return 0.85;
	const sameRole = primaryRole(left.roles) === primaryRole(right.roles);
	if (samePath && sameRole) return 0.8;
	if (samePath) return 0.65;
	const sameComponent = topComponent(left.path) === topComponent(right.path);
	if (sameRole && sameComponent) return 0.35;
	if (sameRole) return 0.2;
	return sameComponent ? 0.1 : 0;
}

function primaryRole(roles: readonly CandidateRole[]): CandidateRole | "other" {
	for (const role of ["caller", "callee", "reference", "test", "import", "registration", "entrypoint", "public_api", "config", "definition", "occurrence", "text"] as const) {
		if (roles.includes(role)) return role;
	}
	return "other";
}

function summarizeFamilies(evidence: readonly RegionEvidence[]): number {
	return new Set(evidence.map((item) => GREP_SOURCE_FAMILY[item.source])).size;
}

function hasFamily(region: CodeRegion, family: RankingEvidenceFamily): boolean {
	return region.evidence.some((item) => GREP_SOURCE_FAMILY[item.source] === family);
}

function hasAnySource(sources: ReadonlySet<RetrievalSource>, expected: readonly RetrievalSource[]): boolean {
	return expected.some((source) => sources.has(source));
}

function rangesOverlap(left: RankedRegion, right: RankedRegion): boolean {
	return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function regionSize(region: RankedRegion): number {
	return Math.max(1, region.endLine - region.startLine + 1);
}

function topComponent(value: string): string {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function normalizeSymbol(value: string): string {
	return value.trim().replace(/::|#/gu, ".").toLocaleLowerCase();
}

function lastSymbolSegment(value: string): string {
	return value.split(".").at(-1) ?? value;
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
