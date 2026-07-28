import { describe, expect, it } from "vitest";

import type { FindGraphCandidate } from "../../src/file-tools/find/graph-source.js";
import { graphNavigationRelation, graphRankingEvidence, isGraphMainCandidate } from "../../src/file-tools/find/graph-ranking.js";
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
			const full = createSourceRankingEvidence("repo-map-direct", 1, 1);
			const low = createSourceRankingEvidence("repo-map-direct", 1, 0.4);
			const semantic = createSourceRankingEvidence("lsp-workspace-symbol", 4);
			expect(low.fusionScore).toBeCloseTo(full.fusionScore * 0.4);
			expect(mergeRankingEvidence(low, semantic)).toEqual(mergeRankingEvidence(semantic, low));
		});

		it("Repo Map 按 confidence、hop 和 edge resolution 校准强度", () => {
			const direct = graphCandidate({ confidence: 1, hop: 0 });
			const lowConfidence = graphCandidate({ confidence: 0.4, hop: 0 });
			const hop1 = graphCandidate({
				confidence: 0.8,
				hop: 1,
				reasons: ["caller"],
				relatedEdges: [{ hop: 1, confidence: 0.5, resolution: "lexical", relatedFiles: [] }],
			});
			expect(graphRankingEvidence(direct, 1).structural).toBeGreaterThan(0);
			expect(graphRankingEvidence(lowConfidence, 1).fusionScore).toBe(0);
			const graph = graphRankingEvidence(hop1, 1);
			expect(graph.graph).toBeGreaterThan(0);
			expect(graph.structural).toBe(0);
			expect(graph.fusionScore).toBeLessThan(graphRankingEvidence(direct, 1).fusionScore);
		});

		it("纯图关系仅在显式关系意图下进入主结果", () => {
			const caller = graphCandidate({ hop: 1, reasons: ["caller"] });
			const test = graphCandidate({ hop: 1, reasons: ["test"] });
			expect(isGraphMainCandidate(caller, "login")).toBe(false);
			expect(isGraphMainCandidate(caller, "callers of login")).toBe(true);
			expect(isGraphMainCandidate(test, "login tests")).toBe(true);
		});

		it("Repo Map alias 使用紧凑 ASCII 映射", () => {
			const alias = graphCandidate({
				reasons: ["alias"],
				matchedAliases: [{ term: "auth", canonical: "authentication" }],
			});
			expect(graphNavigationRelation(alias)).toBe("alias auth->authentication");
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

function graphCandidate(overrides: Partial<FindGraphCandidate>): FindGraphCandidate {
	return {
		path: "target.ts",
		contentHash: "hash",
		confidence: 1,
		hop: 0,
		reasons: ["definition"],
		matchedAliases: [],
		relatedEdges: [],
		...overrides,
	};
}
