import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE, type RankingEvidence } from "../shared/ranking/evidence.js";
export interface GrepGraphCandidate {
	readonly path: string;
	readonly confidence: number;
	readonly hop: 0 | 1 | 2;
	readonly reasons: readonly string[];
	readonly matchedAliases: readonly { readonly term: string; readonly canonical: string }[];
	readonly relatedEdges: readonly {
		readonly hop: 1 | 2;
		readonly confidence: number;
		readonly resolution: "semantic" | "syntactic" | "lexical";
		readonly relatedFiles?: readonly unknown[];
	}[];
}

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

export function isGraphNavigationCandidate(candidate: GrepGraphCandidate): boolean {
	return candidate.confidence >= 0.5 && candidate.reasons.some((reason) => NAVIGATION_REASONS.has(reason));
}

export function graphRankingEvidence(candidate: GrepGraphCandidate, rank: number): RankingEvidence {
	if (candidate.hop === 0 && candidate.confidence >= 0.5 && candidate.reasons.some((reason) => DIRECT_REASONS.has(reason))) {
		return createSourceRankingEvidence("repo-map-direct", rank, candidate.confidence);
	}
	if (candidate.hop === 0) return EMPTY_RANKING_EVIDENCE;
	let best = 0.5;
	for (const edge of candidate.relatedEdges) {
		if (edge.hop !== candidate.hop) continue;
		const resolution = edge.resolution === "semantic" ? 1 : edge.resolution === "syntactic" ? 0.9 : 0.65;
		best = Math.max(best, edge.confidence * resolution);
	}
	return createSourceRankingEvidence(candidate.hop === 1 ? "repo-map-hop-1" : "repo-map-hop-2", rank, candidate.confidence * best);
}

export function isGraphMainCandidate(candidate: GrepGraphCandidate, query: string): boolean {
	if (candidate.hop === 0 && candidate.reasons.some((reason) => DIRECT_REASONS.has(reason))) return true;
	return RELATION_INTENT.some(({ reason, pattern }) => pattern.test(query) && candidate.reasons.includes(reason));
}

export function graphNavigationRelation(candidate: GrepGraphCandidate): string | undefined {
	for (const reason of candidate.reasons) {
		if (!NAVIGATION_REASONS.has(reason)) continue;
		if (reason === "alias") return formatGraphAliasReason(candidate);
		if (reason === "exact qualified symbol" || reason === "exact symbol" || reason === "short symbol") return "symbol";
		return reason;
	}
	return undefined;
}

export function formatGraphAliasReason(candidate: GrepGraphCandidate): string {
	const alias = candidate.matchedAliases.find((match) => match.term.toLocaleLowerCase() !== match.canonical.toLocaleLowerCase());
	return alias === undefined ? "alias" : `alias ${alias.term}->${alias.canonical}`;
}
