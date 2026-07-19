import type { RepoMapMatchReason, RepoMapQueryCandidate } from "../repo-map/query.js";
import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE, type RankingEvidence } from "./ranking-evidence.js";

const NAVIGATION_REASONS = new Set<RepoMapMatchReason>([
	"definition",
	"alias",
	"exact qualified symbol",
	"exact symbol",
	"short symbol",
	"caller",
	"test",
	"entrypoint",
	"public api",
	"registration",
	"export",
	"callee",
	"reference",
	"import",
	"test config",
	"mock",
	"fixture",
	"component",
	"package",
	"snapshot",
]);

const DIRECT_REASONS = new Set<RepoMapMatchReason>([
	"exact path", "exact filename", "path match", "exact qualified symbol", "exact symbol", "short symbol",
	"signature", "alias", "definition", "export", "package", "component", "entrypoint", "registration", "public api",
]);

const RELATION_INTENT: ReadonlyArray<{ reason: RepoMapMatchReason; pattern: RegExp }> = [
	{ reason: "caller", pattern: /\bcallers?\b|\bcalled by\b/iu },
	{ reason: "callee", pattern: /\bcallees?\b|\bcalls?\b/iu },
	{ reason: "reference", pattern: /\breferences?\b|\busages?\b/iu },
	{ reason: "test", pattern: /\btests?\b|\bspecs?\b/iu },
	{ reason: "mock", pattern: /\bmocks?\b/iu },
	{ reason: "fixture", pattern: /\bfixtures?\b/iu },
	{ reason: "registration", pattern: /\bregister(?:ed|s|ing|ation)?\b/iu },
	{ reason: "entrypoint", pattern: /\bentry\s*points?\b|\bentrypoints?\b/iu },
];

/** 关联通道只接收达到 Repo Map 公共可信边界、且具有可导航关系的候选。 */
export function isRepoMapNavigationCandidate(candidate: RepoMapQueryCandidate): boolean {
	return candidate.confidence >= 0.5 && candidate.reasons.some((reason) => NAVIGATION_REASONS.has(reason));
}

/** 只有查询种子的结构/语义关系是独立证据；多跳传播不与名称命中组成共识。 */
export function hasDirectRepoMapEvidence(candidate: RepoMapQueryCandidate): boolean {
	return candidate.hop === 0
		&& candidate.confidence >= 0.5
		&& candidate.reasons.some((reason) => DIRECT_REASONS.has(reason));
}

/** 只在实时 hash 验证后调用；hop 与 edge resolution 决定 family 和强度。 */
export function repoMapRankingEvidence(candidate: RepoMapQueryCandidate, rank: number, freshnessVerified: boolean): RankingEvidence {
	if (!freshnessVerified) return EMPTY_RANKING_EVIDENCE;
	if (hasDirectRepoMapEvidence(candidate)) return createSourceRankingEvidence("repo-map-direct", rank, candidate.confidence);
	if (candidate.hop === 0) return EMPTY_RANKING_EVIDENCE;
	const edgeStrength = repoMapEdgeStrength(candidate);
	const confidence = candidate.confidence * edgeStrength;
	return createSourceRankingEvidence(candidate.hop === 1 ? "repo-map-hop-1" : "repo-map-hop-2", rank, confidence);
}

export function queryRequestsRepoMapRelation(query: string, candidate: RepoMapQueryCandidate): boolean {
	return RELATION_INTENT.some(({ reason, pattern }) => pattern.test(query) && candidate.reasons.includes(reason));
}

/** 图传播默认只进 related；显式关系意图才允许成为主候选。 */
export function isRepoMapMainCandidate(candidate: RepoMapQueryCandidate, query: string): boolean {
	if (candidate.hop === 0 && candidate.reasons.some((reason) => DIRECT_REASONS.has(reason))) return true;
	return queryRequestsRepoMapRelation(query, candidate);
}

export function repoMapNavigationRelation(candidate: RepoMapQueryCandidate): string | undefined {
	for (const reason of candidate.reasons) {
		if (!NAVIGATION_REASONS.has(reason)) continue;
		if (reason === "alias") return formatRepoMapAliasReason(candidate);
		if (reason === "exact qualified symbol" || reason === "exact symbol" || reason === "short symbol") return "symbol";
		return reason;
	}
	return undefined;
}

/** Repo Map alias reason uses an ASCII mapping marker in model-visible output. */
export function formatRepoMapAliasReason(candidate: RepoMapQueryCandidate): string {
	const alias = candidate.matchedAliases.find((match) => match.term.toLocaleLowerCase() !== match.canonical.toLocaleLowerCase());
	return alias === undefined ? "alias" : `alias ${alias.term}->${alias.canonical}`;
}

/** Repo Map 主候选的语义等级；图距离只分层，不转换成固定 boost。 */
export function repoMapEvidenceTier(candidate: RepoMapQueryCandidate): number {
	if (candidate.reasons.includes("exact path")) return 0;
	if (candidate.reasons.includes("exact filename")) return 1;
	if (candidate.hop === 0 && (candidate.reasons.includes("exact qualified symbol") || candidate.reasons.includes("exact symbol"))) return 2;
	if (candidate.reasons.includes("path match")) return 3;
	if (candidate.hop === 0) return 4;
	return candidate.hop === 1 ? 6 : 7;
}

function repoMapEdgeStrength(candidate: RepoMapQueryCandidate): number {
	let best = 0.5;
	for (const edge of candidate.relatedEdges) {
		if (edge.hop !== candidate.hop) continue;
		const resolution = edge.resolution === "semantic" ? 1 : edge.resolution === "syntactic" ? 0.9 : 0.65;
		best = Math.max(best, edge.confidence * resolution);
	}
	return best;
}
