import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE, type RankingEvidence } from "../shared/ranking/evidence.js";
import type { FindGraphCandidate } from "./graph-source.js";

const NAVIGATION_REASONS = new Set([
	"definition", "alias", "exact qualified symbol", "exact symbol", "short symbol", "caller", "test",
	"entrypoint", "public api", "registration", "export", "callee", "reference", "import", "test config",
	"mock", "fixture", "component", "package", "snapshot",
]);
const DIRECT_REASONS = new Set([
	"exact path", "exact filename", "path match", "exact qualified symbol", "exact symbol", "short symbol",
	"signature", "alias", "definition", "export", "package", "component", "entrypoint", "registration", "public api",
]);
const RELATION_INTENT: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
	{ reason: "caller", pattern: /\bcallers?\b|\bcalled by\b/iu },
	{ reason: "callee", pattern: /\bcallees?\b|\bcalls?\b/iu },
	{ reason: "reference", pattern: /\breferences?\b|\busages?\b/iu },
	{ reason: "test", pattern: /\btests?\b|\bspecs?\b/iu },
	{ reason: "mock", pattern: /\bmocks?\b/iu },
	{ reason: "fixture", pattern: /\bfixtures?\b/iu },
	{ reason: "registration", pattern: /\bregister(?:ed|s|ing|ation)?\b/iu },
	{ reason: "entrypoint", pattern: /\bentry\s*points?\b|\bentrypoints?\b/iu },
];

export function isGraphNavigationCandidate(candidate: FindGraphCandidate): boolean {
	return candidate.confidence >= 0.5 && candidate.reasons.some((reason) => NAVIGATION_REASONS.has(reason));
}

function hasDirectGraphEvidence(candidate: FindGraphCandidate): boolean {
	return candidate.hop === 0 && candidate.confidence >= 0.5 && candidate.reasons.some((reason) => DIRECT_REASONS.has(reason));
}

export function graphRankingEvidence(candidate: FindGraphCandidate, rank: number): RankingEvidence {
	if (hasDirectGraphEvidence(candidate)) return createSourceRankingEvidence("repo-map-direct", rank, candidate.confidence);
	if (candidate.hop === 0) return EMPTY_RANKING_EVIDENCE;
	let edgeStrength = 0.5;
	for (const edge of candidate.relatedEdges) {
		if (edge.hop !== candidate.hop) continue;
		const resolution = edge.resolution === "semantic" ? 1 : edge.resolution === "syntactic" ? 0.9 : 0.65;
		edgeStrength = Math.max(edgeStrength, edge.confidence * resolution);
	}
	return createSourceRankingEvidence(candidate.hop === 1 ? "repo-map-hop-1" : "repo-map-hop-2", rank, candidate.confidence * edgeStrength);
}

export function isGraphMainCandidate(candidate: FindGraphCandidate, query: string): boolean {
	if (candidate.hop === 0 && candidate.reasons.some((reason) => DIRECT_REASONS.has(reason))) return true;
	return RELATION_INTENT.some(({ reason, pattern }) => pattern.test(query) && candidate.reasons.includes(reason));
}

export function graphNavigationRelation(candidate: FindGraphCandidate): string | undefined {
	for (const reason of candidate.reasons) {
		if (!NAVIGATION_REASONS.has(reason)) continue;
		if (reason === "alias") {
			const alias = candidate.matchedAliases.find((match) => match.term.toLocaleLowerCase() !== match.canonical.toLocaleLowerCase());
			return alias === undefined ? "alias" : `alias ${alias.term}->${alias.canonical}`;
		}
		if (reason === "exact qualified symbol" || reason === "exact symbol" || reason === "short symbol") return "symbol";
		return reason;
	}
	return undefined;
}

export function graphEvidenceTier(candidate: FindGraphCandidate): number {
	if (candidate.reasons.includes("exact path")) return 0;
	if (candidate.reasons.includes("exact filename")) return 1;
	if (candidate.hop === 0 && (candidate.reasons.includes("exact qualified symbol") || candidate.reasons.includes("exact symbol"))) return 2;
	if (candidate.reasons.includes("path match")) return 3;
	if (candidate.hop === 0) return 4;
	return candidate.hop === 1 ? 6 : 7;
}
