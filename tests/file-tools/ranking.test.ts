import { describe, expect, it } from "vitest";

import {
	compareRankingEvidence,
	createSourceRankingEvidence,
	mergeRankingEvidence,
	rrfContribution,
} from "../../src/file-tools/shared/ranking/evidence.js";
import { selectRelevanceHeadMmr } from "../../src/file-tools/shared/ranking/selection.js";

describe("shared ranking", () => {
	describe("evidence", () => {
		it("weighted RRF 奖励高位和跨 family 共识，同 family 不重复累加", () => {
			const first = createSourceRankingEvidence("path", 1);
			const weakConsensus = mergeRankingEvidence(
				createSourceRankingEvidence("bm25", 160),
				createSourceRankingEvidence("lsp-workspace-symbol", 160),
			);
			const strongConsensus = mergeRankingEvidence(
				createSourceRankingEvidence("path", 2),
				createSourceRankingEvidence("lsp-workspace-symbol", 2),
			);
			const duplicateFamily = mergeRankingEvidence(
				createSourceRankingEvidence("path", 3),
				createSourceRankingEvidence("bm25", 1),
			);

			expect(rrfContribution(1)).toBeCloseTo(1 / 61);
			expect(rrfContribution(2)).toBeLessThan(rrfContribution(1));
			expect(compareRankingEvidence(first, weakConsensus)).toBeLessThan(0);
			expect(compareRankingEvidence(strongConsensus, first)).toBeLessThan(0);
			expect(duplicateFamily.familyCount).toBe(1);
			expect(duplicateFamily.fusionScore).toBe(createSourceRankingEvidence("path", 3).fusionScore);
		});

		it("confidence 线性缩放贡献且合并顺序无关", () => {
			const full = createSourceRankingEvidence("lsp-workspace-symbol", 1, 1);
			const low = createSourceRankingEvidence("lsp-workspace-symbol", 1, 0.4);
			const semantic = createSourceRankingEvidence("lsp-workspace-symbol", 4);
			expect(low.fusionScore).toBeCloseTo(full.fusionScore * 0.4);
			expect(mergeRankingEvidence(low, semantic)).toEqual(mergeRankingEvidence(semantic, low));
		});
	});

	describe("selection", () => {
		it("limit=1 始终返回全局最相关候选", () => {
			const input = [candidate("c", 3), candidate("a", 1), candidate("b", 2)];
			expect(selectRelevanceHeadMmr(input, 1, selectionOptions).map((item) => item.id)).toEqual(["a"]);
		});

		it("保持 relevance head，仅在尾部应用多样性", () => {
			const input = [
				candidate("a", 1, "same"), candidate("b", 2, "same"), candidate("c", 3, "same"),
				candidate("d", 4, "same"), candidate("e", 5, "other"), candidate("f", 6, "third"),
			];
			const selected = selectRelevanceHeadMmr(input, 5, selectionOptions);
			expect(selected.slice(0, 3).map((item) => item.id)).toEqual(["a", "b", "c"]);
			expect(selected.map((item) => item.id)).toContain("e");
		});

		it("多样性不能跨 tier，且动态 cutoff 丢弃明显低质量尾项", () => {
			const tiered = [
				candidate("a", 1, "same", 1), candidate("b", 2, "same", 1),
				candidate("c", 3, "same", 1), candidate("d", 4, "same", 1),
				candidate("diverse", 1, "other", 2),
			];
			expect(selectRelevanceHeadMmr(tiered, 4, selectionOptions).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
			expect(selectRelevanceHeadMmr([
				candidate("strong", 1, "a", 1, 1),
				candidate("weak", 2, "b", 1, 0.29),
			], 2, selectionOptions).map((item) => item.id)).toEqual(["strong"]);
		});

		it("空输入和非正限制返回空结果", () => {
			expect(selectRelevanceHeadMmr([], 4, selectionOptions)).toEqual([]);
			expect(selectRelevanceHeadMmr([candidate("a", 1)], 0, selectionOptions)).toEqual([]);
		});
	});
});

interface Candidate {
	id: string;
	group: string;
	tier: number;
	rank: number;
	score: number;
}

const compare = (left: Candidate, right: Candidate): number => left.tier - right.tier || left.rank - right.rank || left.id.localeCompare(right.id);
const selectionOptions = {
	compare,
	tier: (value: Candidate) => value.tier,
	score: (value: Candidate) => value.score,
	identity: (value: Candidate) => value.id,
	similarity: (left: Candidate, right: Candidate) => left.group === right.group ? 0.8 : 0,
};

function candidate(id: string, rank: number, group = id, tier = 1, score = 1): Candidate {
	return { id, rank, group, tier, score };
}
