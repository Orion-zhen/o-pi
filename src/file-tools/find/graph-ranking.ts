import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE, type RankingEvidence } from "../shared/ranking/evidence.js";
import type { FindGraphCandidate } from "./graph-source.js";

const DIRECT_REASONS = new Set([
	"exact path", "exact filename", "path match", "exact qualified symbol", "exact symbol", "short symbol",
	"signature", "alias", "definition", "export", "package", "component", "entrypoint", "registration", "public api",
]);
const FALLBACK_REASONS = new Set(["registration", "entrypoint"]);
const HIGH_CONFIDENCE = 0.8;

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

/** 只有强 exact symbol 或 registration/entrypoint 文件可在路径召回为空时回退。 */
export function isGraphFallbackCandidate(candidate: FindGraphCandidate): boolean {
	if (candidate.confidence < HIGH_CONFIDENCE) return false;
	if (candidate.hop === 0 && candidate.reasons.some((reason) => reason === "exact qualified symbol" || reason === "exact symbol")) return true;
	return candidate.reasons.some((reason) => FALLBACK_REASONS.has(reason));
}

export function graphEvidenceTier(candidate: FindGraphCandidate): number {
	if (candidate.reasons.includes("exact path")) return 0;
	if (candidate.reasons.includes("exact filename")) return 1;
	if (candidate.hop === 0 && (candidate.reasons.includes("exact qualified symbol") || candidate.reasons.includes("exact symbol"))) return 2;
	if (candidate.reasons.includes("path match")) return 3;
	if (candidate.hop === 0) return 4;
	return candidate.hop === 1 ? 6 : 7;
}
