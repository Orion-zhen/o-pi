import type {
	CandidateRole,
	CandidateSignal,
	CodeRegion,
	RankedRegion,
	RankingEvidenceSummary,
	RegionEvidence,
	RetrievalSource,
} from "./candidates.js";
import type { QueryPlan, RelationIntent } from "./query-plan.js";

export type RankingEvidenceFamily = "factual" | "symbol" | "lexical" | "semantic" | "graph";
export type RankingPolicyKey = "strict" | "identifier" | "qualified_symbol" | "long_text" | "natural_language" | "relation";

export const GREP_RRF_K = 60;

export const GREP_SOURCE_FAMILY: Readonly<Record<RetrievalSource, RankingEvidenceFamily>> = {
	"text-literal": "factual",
	"text-regex": "factual",
	"ast-symbol": "symbol",
	"ast-lexical": "lexical",
	"ast-relation": "graph",
	"lsp-symbol": "semantic",
	"lsp-reference": "semantic",
	"repo-map-direct": "semantic",
	"repo-map-hop-1": "graph",
	"repo-map-hop-2": "graph",
	path: "lexical",
};

/** 查询形态的相对权重只在此表中校准。 */
export const GREP_SOURCE_WEIGHTS: Readonly<Record<RankingPolicyKey, Readonly<Record<RetrievalSource, number>>>> = {
	strict: weights({ "text-literal": 1.5, "text-regex": 1.5, "ast-symbol": 0.45, "lsp-symbol": 0.3, "repo-map-direct": 0.25 }),
	identifier: weights({ "text-literal": 1.05, "ast-symbol": 1.35, "ast-lexical": 0.55, "ast-relation": 0.25, "lsp-symbol": 1.15, "lsp-reference": 0.45, "repo-map-direct": 0.9, "repo-map-hop-1": 0.25, "repo-map-hop-2": 0.1, path: 0.15 }),
	qualified_symbol: weights({ "text-literal": 1.1, "ast-symbol": 1.5, "ast-lexical": 0.45, "ast-relation": 0.35, "lsp-symbol": 1.25, "lsp-reference": 0.75, "repo-map-direct": 1, "repo-map-hop-1": 0.3, "repo-map-hop-2": 0.12, path: 0.1 }),
	long_text: weights({ "text-literal": 1.6, "ast-symbol": 0.35, "ast-lexical": 0.8, "lsp-symbol": 0.3, "lsp-reference": 0.2, "repo-map-direct": 0.45, "repo-map-hop-1": 0.15, "repo-map-hop-2": 0.05, path: 0.08 }),
	natural_language: weights({ "text-literal": 0.8, "ast-symbol": 0.65, "ast-lexical": 1.25, "ast-relation": 0.35, "lsp-symbol": 0.75, "lsp-reference": 0.45, "repo-map-direct": 1.1, "repo-map-hop-1": 0.4, "repo-map-hop-2": 0.16, path: 0.2 }),
	relation: weights({ "text-literal": 0.75, "ast-symbol": 0.8, "ast-lexical": 0.4, "ast-relation": 1.3, "lsp-symbol": 0.8, "lsp-reference": 1.35, "repo-map-direct": 0.9, "repo-map-hop-1": 1.15, "repo-map-hop-2": 0.45, path: 0.05 }),
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
		verified_text_window: 3,
	},
	identifier: {
		exact_qualified_definition: 1,
		exact_symbol_definition: 2,
		verified_phrase: 3,
		verified_text: 3,
		verified_enclosing_region: 3,
		direct_symbol: 4,
		symbol_prefix: 5,
		partial_symbol: 5,
		lexical_high_coverage: 6,
		lexical: 7,
	},
	qualified_symbol: {
		exact_qualified_definition: 1,
		exact_member_definition: 2,
		exact_symbol_definition: 2,
		verified_qualified_occurrence: 3,
		verified_phrase: 3,
		verified_text: 3,
		direct_reference: 4,
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
		verified_text_window: 2,
		lexical_high_coverage: 3,
		multiview_consensus: 3,
		lexical: 4,
	},
	natural_language: {
		verified_phrase: 1,
		verified_text: 1,
		lexical_high_coverage: 2,
		multiview_consensus: 3,
		repo_summary: 4,
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
		direct_reference: 3,
		indirect_relation: 4,
		lexical_high_coverage: 5,
		lexical: 6,
	},
};

const RELATION_ROLES = new Set<CandidateRole>(["caller", "callee", "reference", "test", "import", "registration"]);
const ROLE_BY_INTENT: Readonly<Record<RelationIntent, CandidateRole>> = {
	caller: "caller",
	callee: "callee",
	reference: "reference",
	test: "test",
	import: "import",
	registration: "registration",
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

/** 对已准入区域执行纯排序；path-only 和 lane 非 main 候选不会进入主结果。 */
export function rankCodeRegions(plan: QueryPlan, regions: readonly CodeRegion[]): RankedRegion[] {
	const policy = rankingPolicyFor(plan);
	const ranked: RankedRegion[] = [];
	for (const region of regions) {
		if (!isMainEligible(plan, region)) continue;
		const tier = bestTier(policy, region.signals);
		if (tier === undefined) continue;
		ranked.push({
			...region,
			tier,
			ranking: summarizeEvidence(policy, region.evidence),
			verifiedCoverage: verifiedCoverage(region),
			requestedRolePriority: rolePriority(plan, region.roles),
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
		|| right.ranking.fusionScore - left.ranking.fusionScore
		|| right.ranking.bestContribution - left.ranking.bestContribution
		|| right.verifiedCoverage - left.verifiedCoverage
		|| right.requestedRolePriority - left.requestedRolePriority
		|| regionSize(left) - regionSize(right)
		|| compareString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine
		|| compareString(left.id, right.id);
}

/** relevance head 后只在同一 tier 内重排，永不让较差 tier 越级。 */
export function selectRankedRegions(candidates: readonly RankedRegion[], limit: number, headSize = 3): RankedRegion[] {
	if (limit <= 0) return [];
	const ranked = [...candidates].sort(compareRankedRegions);
	const selected: RankedRegion[] = [];
	let offset = 0;
	while (offset < ranked.length && selected.length < limit) {
		const tier = ranked[offset]?.tier;
		if (tier === undefined) break;
		let end = offset + 1;
		while (ranked[end]?.tier === tier) end += 1;
		const group = ranked.slice(offset, end);
		const remainingCapacity = limit - selected.length;
		if (group.length <= remainingCapacity) selected.push(...group);
		else selected.push(...selectWithinTier(group, remainingCapacity, headSize));
		offset = end;
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
	const hopFactor = evidence.hop === undefined || evidence.hop === 0 ? 1 : evidence.hop === 1 ? 0.7 : 0.4;
	return GREP_SOURCE_WEIGHTS[policy][evidence.source] * confidence * hopFactor / (GREP_RRF_K + rank);
}

function weights(overrides: Partial<Record<RetrievalSource, number>>): Readonly<Record<RetrievalSource, number>> {
	return {
		"text-literal": 0,
		"text-regex": 0,
		"ast-symbol": 0,
		"ast-lexical": 0,
		"ast-relation": 0,
		"lsp-symbol": 0,
		"lsp-reference": 0,
		"repo-map-direct": 0,
		"repo-map-hop-1": 0,
		"repo-map-hop-2": 0,
		path: 0,
		...overrides,
	};
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
	if (region.lane !== "main") return false;
	if (region.signals.length === 0 || region.signals.every((signal) => signal === "path")) return false;
	if (plan.match !== "auto") return region.queryMatch === "verified";
	if (plan.relationIntents.length > 0) return true;
	const relationOnly = region.roles.length > 0 && region.roles.every((role) => RELATION_ROLES.has(role));
	if (!relationOnly) return true;
	return plan.shape === "qualified_symbol" && region.roles.every((role) => role === "reference");
}

function verifiedCoverage(region: CodeRegion): number {
	if (region.queryMatch !== "verified") return 0;
	return region.matchLines.length / Math.max(1, region.endLine - region.startLine + 1);
}

function rolePriority(plan: QueryPlan, roles: readonly CandidateRole[]): number {
	const requested = new Set(plan.relationIntents.map((intent) => ROLE_BY_INTENT[intent]));
	if (roles.some((role) => requested.has(role))) return 3;
	if (roles.includes("definition")) return 2;
	if (roles.includes("occurrence") || roles.includes("text")) return 1;
	return 0;
}

function selectWithinTier(group: readonly RankedRegion[], limit: number, headSize: number): RankedRegion[] {
	const head = group.slice(0, Math.min(limit, headSize));
	const remaining = group.slice(head.length);
	while (head.length < limit && remaining.length > 0) {
		let bestIndex = 0;
		let bestUtility = Number.NEGATIVE_INFINITY;
		for (const [index, candidate] of remaining.entries()) {
			const relevance = 1 - index / Math.max(1, remaining.length);
			const redundancy = head.reduce((maximum, selected) => Math.max(maximum, similarity(candidate, selected)), 0);
			const utility = 0.85 * relevance - 0.15 * redundancy;
			if (utility > bestUtility) {
				bestUtility = utility;
				bestIndex = index;
			}
		}
		const [next] = remaining.splice(bestIndex, 1);
		if (next !== undefined) head.push(next);
	}
	return head;
}

function similarity(left: RankedRegion, right: RankedRegion): number {
	if (left.path === right.path && left.symbol !== undefined && left.symbol === right.symbol) return 1;
	if (left.path === right.path && rangesOverlap(left, right)) return 0.9;
	if (left.path === right.path) return 0.6;
	if (left.roles.some((role) => right.roles.includes(role))) return 0.25;
	return 0;
}

function rangesOverlap(left: RankedRegion, right: RankedRegion): boolean {
	return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function regionSize(region: RankedRegion): number {
	return Math.max(1, region.endLine - region.startLine + 1);
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
