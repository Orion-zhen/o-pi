import { describe, expect, it } from "vitest";

import {
	compareRankingEvidence,
	createSourceRankingEvidence,
	mergeRankingEvidence,
	rrfContribution,
} from "../../src/file-tools/ranking-evidence.js";
import { formatRepoMapAliasReason, isRepoMapMainCandidate, repoMapNavigationRelation, repoMapRankingEvidence } from "../../src/file-tools/repo-map-ranking.js";
import type { RepoMapQueryCandidate } from "../../src/repo-map/query.js";

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
		const direct = repoCandidate({ confidence: 1, hop: 0 });
		const lowConfidence = repoCandidate({ confidence: 0.4, hop: 0 });
		const hop1 = repoCandidate({
			confidence: 0.8,
			hop: 1,
			reasons: ["caller"],
			relatedEdges: [{
				kind: "calls", from: "a", to: "b", confidence: 0.5, resolution: "lexical", source: "syntax", hop: 1,
				evidence: [], relatedFiles: [],
			}],
		});
		expect(repoMapRankingEvidence(direct, 1, true).structural).toBeGreaterThan(0);
		expect(repoMapRankingEvidence(lowConfidence, 1, true).fusionScore).toBe(0);
		const graph = repoMapRankingEvidence(hop1, 1, true);
		expect(graph.graph).toBeGreaterThan(0);
		expect(graph.structural).toBe(0);
		expect(graph.fusionScore).toBeLessThan(repoMapRankingEvidence(direct, 1, true).fusionScore);
		expect(repoMapRankingEvidence(direct, 1, false).fusionScore).toBe(0);
	});

	it("纯图关系默认属于 related，明确关系意图才进入主结果", () => {
		const caller = repoCandidate({ hop: 1, reasons: ["caller"] });
		const test = repoCandidate({ hop: 1, reasons: ["test"] });
		expect(isRepoMapMainCandidate(caller, "login")).toBe(false);
		expect(isRepoMapMainCandidate(caller, "callers of login")).toBe(true);
		expect(isRepoMapMainCandidate(test, "login tests")).toBe(true);
	});

	it("Repo Map alias 使用紧凑 ASCII 映射标记", () => {
		const alias = repoCandidate({
			reasons: ["alias"],
			matchedAliases: [{
				term: "auth",
				canonical: "authentication",
				source: "symbol",
				confidence: 1,
				evidence: [],
			}],
		});

		expect(formatRepoMapAliasReason(alias)).toBe("alias auth->authentication");
		expect(repoMapNavigationRelation(alias)).toBe("alias auth->authentication");
	});
});

function repoCandidate(overrides: Partial<RepoMapQueryCandidate>): RepoMapQueryCandidate {
	return {
		path: "target.ts",
		fileId: "file:target.ts",
		contentHash: "hash",
		score: 1,
		confidence: 1,
		hop: 0,
		reasons: ["definition"],
		matchedAliases: [],
		relatedEdges: [],
		...overrides,
	};
}
