export const RELEVANCE_HEAD_SIZE = 3;
export const MMR_LAMBDA = 0.85;
export const SAME_TIER_SCORE_RATIO_CUTOFF = 0.3;

export interface RankingSelectionOptions<T> {
	compare(left: T, right: T): number;
	tier(candidate: T): number;
	score(candidate: T): number;
	consensus?(candidate: T): boolean;
	identity(candidate: T): string;
	similarity(left: T, right: T): number;
	headSize?: number;
	lambda?: number;
}

/** relevance head 原样保留，剩余名额按 tier 约束的轻量 MMR 软选择。 */
export function selectRelevanceHeadMmr<T>(
	candidates: readonly T[],
	limit: number,
	options: RankingSelectionOptions<T>,
): T[] {
	if (limit <= 0 || candidates.length === 0) return [];
	const ranked = deduplicate(candidates, options).sort(options.compare);
	const eligible = applyDynamicCutoff(ranked, options);
	const target = Math.min(limit, eligible.length);
	const headCount = Math.min(options.headSize ?? RELEVANCE_HEAD_SIZE, target);
	const selected = eligible.slice(0, headCount);
	if (selected.length === target) return selected;

	const remaining = eligible.slice(headCount);
	const relevance = remaining.map((_candidate, index) => normalizedRelevance(index + headCount, eligible.length));
	const redundancy = remaining.map(() => 0);
	const evaluatedSelections = remaining.map(() => 0);
	const lambda = options.lambda ?? MMR_LAMBDA;
	while (selected.length < target && remaining.length > 0) {
		const bestTier = options.tier(remaining[0] as T);
		let bestIndex = -1;
		let bestUtility = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < remaining.length; index += 1) {
			const candidate = remaining[index];
			if (candidate === undefined) continue;
			if (options.tier(candidate) !== bestTier) break;
			const candidateRelevance = relevance[index] ?? 0;
			if (lambda * candidateRelevance <= bestUtility) break;
			let maximum = redundancy[index] ?? 0;
			for (let selectedIndex = evaluatedSelections[index] ?? 0; selectedIndex < selected.length; selectedIndex += 1) {
				const chosen = selected[selectedIndex];
				if (chosen !== undefined) maximum = Math.max(maximum, options.similarity(candidate, chosen));
			}
			redundancy[index] = maximum;
			evaluatedSelections[index] = selected.length;
			const utility = lambda * candidateRelevance - (1 - lambda) * maximum;
			if (utility > bestUtility) {
				bestUtility = utility;
				bestIndex = index;
			}
		}
		if (bestIndex < 0) break;
		const [chosen] = remaining.splice(bestIndex, 1);
		relevance.splice(bestIndex, 1);
		redundancy.splice(bestIndex, 1);
		evaluatedSelections.splice(bestIndex, 1);
		if (chosen !== undefined) {
			selected.push(chosen);
		}
	}
	const head = selected.slice(0, headCount);
	const tail = selected.slice(headCount).sort(options.compare);
	return [...head, ...tail];
}

function applyDynamicCutoff<T>(ranked: T[], options: RankingSelectionOptions<T>): T[] {
	const bestByTier = new Map<number, number>();
	for (const candidate of ranked) {
		const tier = options.tier(candidate);
		if (!bestByTier.has(tier)) bestByTier.set(tier, options.score(candidate));
	}
	return ranked.filter((candidate) => {
		const score = options.score(candidate);
		const best = bestByTier.get(options.tier(candidate)) ?? 0;
		return best <= 0 || score >= best * SAME_TIER_SCORE_RATIO_CUTOFF || options.consensus?.(candidate) === true;
	});
}

function deduplicate<T>(candidates: readonly T[], options: RankingSelectionOptions<T>): T[] {
	const best = new Map<string, T>();
	for (const candidate of candidates) {
		const key = options.identity(candidate);
		const previous = best.get(key);
		if (previous === undefined || options.compare(candidate, previous) < 0) best.set(key, candidate);
	}
	return [...best.values()];
}

function normalizedRelevance(index: number, total: number): number {
	return total <= 1 ? 1 : 1 - index / (total - 1);
}
