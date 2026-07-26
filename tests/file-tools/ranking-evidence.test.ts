import { describe, expect, it } from "vitest";

import {
	compareRankingEvidence,
	createSourceRankingEvidence,
	mergeRankingEvidence,
	rrfContribution,
} from "../../src/file-tools/shared/ranking/evidence.js";
import {
	graphNavigationRelation,
	graphRankingEvidence,
	isGraphMainCandidate,
} from "../../src/file-tools/find/graph-ranking.js";
import type { FindGraphCandidate } from "../../src/file-tools/find/graph-source.js";

describe("ranking evidence", () => {
	it("单 family 第一名可以超过多个 family 的末位候选", () => {
		const first = createSourceRankingEvidence("path", 1);
		const weakConsensus = mergeRankingEvidence(
			createSourceRankingEvidence("bm25", 160),
			createSourceRankingEvidence("lsp-workspace-symbol", 160),
		);
		expect(compareRankingEvidence(first, weakConsensus)).toBeLessThan(0);
	});

	it("两个来源均高排名时形成有效共识", () => {
		const consensus = mergeRankingEvidence(
			createSourceRankingEvidence("path", 2),
			createSourceRankingEvidence("lsp-workspace-symbol", 2),
		);
		const single = createSourceRankingEvidence("path", 1);
		expect(compareRankingEvidence(consensus, single)).toBeLessThan(0);
	});

	it("同 family 重复证据只保留最大贡献", () => {
		const strong = createSourceRankingEvidence("path", 3);
		const merged = mergeRankingEvidence(strong, createSourceRankingEvidence("bm25", 1));
		expect(merged.familyCount).toBe(1);
		expect(merged.fusionScore).toBe(strong.fusionScore);
	});

	it("confidence 线性降低贡献且合并顺序无关", () => {
		const full = createSourceRankingEvidence("repo-map-direct", 1, 1);
		const low = createSourceRankingEvidence("repo-map-direct", 1, 0.4);
		expect(low.fusionScore).toBeCloseTo(full.fusionScore * 0.4);
		const semantic = createSourceRankingEvidence("lsp-workspace-symbol", 4);
		expect(mergeRankingEvidence(low, semantic)).toEqual(mergeRankingEvidence(semantic, low));
	});

	it("weighted RRF 使用集中 k 和一基 rank", () => {
		expect(rrfContribution(1)).toBeCloseTo(1 / 61);
		expect(rrfContribution(2)).toBeLessThan(rrfContribution(1));
	});

	it("Repo Map confidence、hop 和 edge resolution 校准 family 强度", () => {
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

	it("纯图关系默认属于 related，明确关系意图才进入主结果", () => {
		const caller = graphCandidate({ hop: 1, reasons: ["caller"] });
		const test = graphCandidate({ hop: 1, reasons: ["test"] });
		expect(isGraphMainCandidate(caller, "login")).toBe(false);
		expect(isGraphMainCandidate(caller, "callers of login")).toBe(true);
		expect(isGraphMainCandidate(test, "login tests")).toBe(true);
	});

	it("Repo Map alias 使用紧凑 ASCII 映射标记", () => {
		const alias = graphCandidate({
			reasons: ["alias"],
			matchedAliases: [{ term: "auth", canonical: "authentication" }],
		});
		expect(graphNavigationRelation(alias)).toBe("alias auth->authentication");
	});
});

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
