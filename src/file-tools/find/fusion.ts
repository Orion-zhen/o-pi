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

/** 路径与 Repo Map 候选按 path 合并；只有发生碰撞时才复制输入候选。 */
export function mergeRankedFindSources(primary: RankedFindEntry[], repoMap: RankedFindEntry[]): RankedFindEntry[] {
	const fused = fuseRankedFindSources(primary, repoMap);
	if (fused === primary) return primary;
	return fused.sort(compareRankedFindEntries);
}

export function fuseRankedFindSources(primary: RankedFindEntry[], repoMap: RankedFindEntry[]): RankedFindEntry[] {
	if (repoMap.length === 0) return primary;
	const byPath = new Map<string, RankedFindEntry>();
	const owned = new Set<string>();
	for (const candidate of primary) mergeCandidate(byPath, owned, candidate);
	for (const candidate of repoMap) mergeCandidate(byPath, owned, candidate);
	return [...byPath.values()];
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

function mergeCandidate(byPath: Map<string, RankedFindEntry>, owned: Set<string>, candidate: RankedFindEntry): void {
	const key = candidate.entry.path;
	const existing = byPath.get(key);
	if (existing === undefined) {
		byPath.set(key, candidate);
		return;
	}
	const alreadyOwned = owned.has(key);
	const target = alreadyOwned ? existing : { ...existing };
	if (!alreadyOwned) {
		byPath.set(key, target);
		owned.add(key);
	}
	target.tier = Math.min(target.tier, candidate.tier);
	target.evidence = mergeRankingEvidence(target.evidence, candidate.evidence);
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
