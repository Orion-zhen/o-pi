import { compareRankingEvidence, mergeRankingEvidence } from "../shared/ranking/evidence.js";
import { selectRelevanceHeadMmr } from "../shared/ranking/selection.js";
import type { RankedGrepRegion } from "./ranker.js";

interface GrepSimilarityProfile {
	path: string;
	symbol?: string;
	kind: string;
	signature?: string;
	role: string;
	component: string;
}

const GREP_SIMILARITY_PROFILES = new WeakMap<RankedGrepRegion, GrepSimilarityProfile>();

/** 需要完整顺序时执行一次融合排序；工具主链使用 fuse + 有界选择。 */
export function mergeRankedGrepSources(primary: RankedGrepRegion[], ...additionalSources: RankedGrepRegion[][]): RankedGrepRegion[] {
	const fused = fuseRankedGrepSources(primary, ...additionalSources);
	if (fused === primary) return primary;
	return fused.sort(compareRankedGrepRegions);
}

export function fuseRankedGrepSources(primary: RankedGrepRegion[], ...additionalSources: RankedGrepRegion[][]): RankedGrepRegion[] {
	if (additionalSources.every((source) => source.length === 0)) return primary;
	const fused: RankedGrepRegion[] = [];
	const strictIndexes = new Map<string, number>();
	const symbolIndexes = new Map<string, number[]>();
	const owned = new Set<number>();
	for (const region of primary) mergeRegion(fused, strictIndexes, symbolIndexes, owned, region);
	for (const source of additionalSources) {
		for (const region of source) mergeRegion(fused, strictIndexes, symbolIndexes, owned, region);
	}
	return fused;
}

export function selectRankedGrepCandidates(candidates: readonly RankedGrepRegion[], limit: number): RankedGrepRegion[] {
	return selectRelevanceHeadMmr(candidates, limit, {
		compare: compareRankedGrepRegions,
		tier: (candidate) => candidate.tier,
		score: (candidate) => candidate.evidence.fusionScore,
		consensus: (candidate) => candidate.evidence.familyCount >= 2,
		identity: regionIdentity,
		similarity: grepSimilarity,
	});
}

export function compareRankedGrepRegions(left: RankedGrepRegion, right: RankedGrepRegion): number {
	return left.tier - right.tier
		|| compareRankingEvidence(left.evidence, right.evidence)
		|| (left.endLine - left.startLine) - (right.endLine - right.startLine)
		|| compareStableString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine;
}

function mergeRegion(
	fused: RankedGrepRegion[],
	strictIndexes: Map<string, number>,
	symbolIndexes: Map<string, number[]>,
	owned: Set<number>,
	region: RankedGrepRegion,
): void {
	const symbolKey = region.symbol === undefined ? undefined : `${region.path}\0${region.symbol.toLocaleLowerCase()}`;
	const candidates = symbolKey === undefined ? undefined : symbolIndexes.get(symbolKey);
	let index = candidates?.find((candidateIndex) => {
		const existing = fused[candidateIndex];
		return existing !== undefined && equivalentRegion(existing, region);
	});
	if (index === undefined) index = strictIndexes.get(region.id);
	if (index === undefined) {
		const nextIndex = fused.length;
		fused.push(region);
		strictIndexes.set(region.id, nextIndex);
		if (symbolKey !== undefined) {
			const indexes = symbolIndexes.get(symbolKey);
			if (indexes === undefined) symbolIndexes.set(symbolKey, [nextIndex]);
			else indexes.push(nextIndex);
		}
		return;
	}
	const existing = fused[index];
	if (existing === undefined) return;
	const alreadyOwned = owned.has(index);
	const target = alreadyOwned ? existing : cloneRegion(existing);
	if (!alreadyOwned) {
		fused[index] = target;
		owned.add(index);
	}
	target.tier = Math.min(target.tier, region.tier);
	target.evidence = mergeRankingEvidence(target.evidence, region.evidence);
	target.lexicalRelevance = Math.max(target.lexicalRelevance, region.lexicalRelevance);
	target.pathRelevance = Math.max(target.pathRelevance, region.pathRelevance);
	if (region.repoMap === true) target.repoMap = true;
	mergeUnique(target.reasons, region.reasons);
	mergeUnique(target.matchLines, region.matchLines);
	mergeUnique(target.callees, region.callees);
	mergeUnique(target.imports, region.imports);
}

function cloneRegion(region: RankedGrepRegion): RankedGrepRegion {
	return {
		...region,
		reasons: [...region.reasons],
		matchLines: [...region.matchLines],
		callees: [...region.callees],
		imports: [...region.imports],
	};
}

function mergeUnique<T>(target: T[], source: readonly T[]): void {
	for (const item of source) if (!target.includes(item)) target.push(item);
}

export function regionIdentity(region: RankedGrepRegion): string {
	const profile = grepSimilarityProfile(region);
	const symbol = profile.symbol;
	if (symbol === undefined) return region.id;
	return `${profile.path}\0${symbol}\0${profile.kind}\0${profile.signature ?? rangeCluster(region.startLine)}`;
}

function grepSimilarity(left: RankedGrepRegion, right: RankedGrepRegion): number {
	if (equivalentRegion(left, right)) return 1;
	const leftProfile = grepSimilarityProfile(left);
	const rightProfile = grepSimilarityProfile(right);
	if (leftProfile.symbol !== undefined && leftProfile.symbol === rightProfile.symbol) return 0.92;
	const samePath = leftProfile.path === rightProfile.path;
	const sameRole = leftProfile.role === rightProfile.role;
	if (samePath && sameRole) return 0.8;
	if (samePath) return 0.55;
	const sameComponent = leftProfile.component === rightProfile.component;
	if (sameComponent && sameRole) return 0.25;
	return sameComponent ? 0.1 : 0;
}

function candidateRole(region: RankedGrepRegion): string {
	for (const role of ["caller", "callee", "reference", "test", "mock", "fixture", "registration", "entrypoint"] as const) {
		if (region.reasons.includes(role)) return role;
	}
	return region.reasons.some((reason) => reason.includes("symbol") || reason === "definition") ? "definition" : "text";
}

function topComponent(value: string): string {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function equivalentRegion(left: RankedGrepRegion, right: RankedGrepRegion): boolean {
	const leftProfile = grepSimilarityProfile(left);
	const rightProfile = grepSimilarityProfile(right);
	if (leftProfile.path !== rightProfile.path) return false;
	if (leftProfile.symbol === undefined || rightProfile.symbol === undefined || leftProfile.symbol !== rightProfile.symbol) return false;
	if (leftProfile.kind !== rightProfile.kind) return false;
	if (leftProfile.signature !== undefined && rightProfile.signature !== undefined && leftProfile.signature !== rightProfile.signature) return false;
	return rangesOverlap(left, right) || Math.abs(left.startLine - right.startLine) <= 2;
}

function rangesOverlap(left: RankedGrepRegion, right: RankedGrepRegion): boolean {
	return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function normalizeSignature(value: string | undefined): string | undefined {
	return value?.replace(/\s+/gu, " ").trim().toLocaleLowerCase() || undefined;
}

function grepSimilarityProfile(candidate: RankedGrepRegion): GrepSimilarityProfile {
	const cached = GREP_SIMILARITY_PROFILES.get(candidate);
	if (cached !== undefined) return cached;
	const signature = normalizeSignature(candidate.signature);
	const profile: GrepSimilarityProfile = {
		path: candidate.path,
		...(candidate.symbol !== undefined ? { symbol: candidate.symbol.toLocaleLowerCase() } : {}),
		kind: candidate.kind.toLocaleLowerCase(),
		...(signature !== undefined ? { signature } : {}),
		role: candidateRole(candidate),
		component: topComponent(candidate.path),
	};
	GREP_SIMILARITY_PROFILES.set(candidate, profile);
	return profile;
}

function rangeCluster(line: number): number {
	return Math.floor(Math.max(0, line - 1) / 3);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
