import { compareRankingEvidence, mergeRankingEvidence } from "../shared/ranking/evidence.js";
import { selectRelevanceHeadMmr } from "../shared/ranking/selection.js";
import type { RankedFindEntry } from "./ranker.js";

interface FindSimilarityProfile {
	path: string;
	component: string;
	kind: string;
	basename: string;
}

const FIND_SIMILARITY_PROFILES = new WeakMap<RankedFindEntry, FindSimilarityProfile>();

/** 合并同一路径在多个显式 scope 中产生的排序证据。 */
export function mergeRankedFindEntries(left: RankedFindEntry, right: RankedFindEntry): RankedFindEntry {
	return {
		...left,
		tier: Math.min(left.tier, right.tier),
		evidence: mergeRankingEvidence(left.evidence, right.evidence),
	};
}

export function selectRankedFindEntries(candidates: readonly RankedFindEntry[], limit: number): RankedFindEntry[] {
	return selectRelevanceHeadMmr(candidates, limit, {
		compare: compareRankedFindEntries,
		tier: (candidate) => candidate.tier,
		score: (candidate) => candidate.evidence.fusionScore,
		consensus: (candidate) => candidate.evidence.familyCount >= 2,
		identity: (candidate) => candidate.entry.path,
		similarity: findSimilarity,
	});
}

export function compareRankedFindEntries(left: RankedFindEntry, right: RankedFindEntry): number {
	return left.tier - right.tier
		|| compareRankingEvidence(left.evidence, right.evidence)
		|| left.entry.path.length - right.entry.path.length
		|| left.entry.depth - right.entry.depth
		|| compareStableString(left.entry.path, right.entry.path);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function topDirectory(value: string): string {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function findSimilarity(left: RankedFindEntry, right: RankedFindEntry): number {
	const leftProfile = findSimilarityProfile(left);
	const rightProfile = findSimilarityProfile(right);
	if (leftProfile.path === rightProfile.path) return 1;
	const sameComponent = leftProfile.component === rightProfile.component;
	const sameKind = leftProfile.kind === rightProfile.kind;
	const sameBasename = leftProfile.basename === rightProfile.basename;
	if (sameBasename && sameKind) return 0.8;
	if (sameComponent && sameKind) return 0.22;
	if (sameComponent) return 0.1;
	return 0;
}

function findSimilarityProfile(candidate: RankedFindEntry): FindSimilarityProfile {
	const cached = FIND_SIMILARITY_PROFILES.get(candidate);
	if (cached !== undefined) return cached;
	const profile = {
		path: candidate.entry.path,
		component: topDirectory(candidate.entry.path),
		kind: candidate.entry.kind,
		basename: candidate.entry.basename.toLocaleLowerCase(),
	};
	FIND_SIMILARITY_PROFILES.set(candidate, profile);
	return profile;
}
