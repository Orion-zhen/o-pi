import { describe, expect, it } from "vitest";

import { mergeRankedFindEntries } from "../../src/file-tools/find/fusion.js";
import { createFindEntry } from "../../src/file-tools/find/ranker.js";
import { renderFindResults } from "../../src/file-tools/find/renderer.js";
import { createRankingEvidence } from "../../src/file-tools/shared/ranking/evidence.js";
import { countTextTokensSync } from "../../src/token-counter.js";

describe("find renderer and fusion", () => {
	it("紧凑输出省略可推导元数据、共享路径前缀并把截断状态放在首行", () => {
		const base = {
			query: "handler",
			path: ".",
			strategy: "fuzzy" as const,
			totalMatches: 2,
			matches: [
				{ path: "src/features/authentication/first-handler.ts", kind: "file" as const },
				{ path: "src/features/authentication/second-handler.ts", kind: "file" as const },
			],
			ignoredCount: 0,
			skippedCount: 0,
			depthLimited: false,
			resultLimited: false,
			outputTokenBudget: 1_000,
		};
		const compact = renderFindResults(base);
		expect(compact.content).toBe([
			"in src/features/authentication/",
			"  first-handler.ts",
			"  second-handler.ts",
		].join("\n"));

		const constrained = renderFindResults({ ...base, depthLimited: true, outputTokenBudget: 14 });
		expect(constrained.content.split("\n")[0]).toBe("found>=2; truncated=depth,output");
		expect(constrained.details).toMatchObject({ depthLimited: true, resultLimited: false, outputTruncated: true });
		expect(countTextTokensSync(constrained.content).tokens).toBeLessThanOrEqual(14);
	});

	it("nearby 候选超预算时不输出残缺标签，并退回扫描摘要", () => {
		const result = renderFindResults({
			query: "missing",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 0,
			matches: [],
			ignoredCount: 1,
			skippedCount: 2,
			depthLimited: false,
			resultLimited: false,
			outputTokenBudget: 32,
			nearby: [{ path: `src/${"very-long-segment-".repeat(20)}.ts`, kind: "file", reason: "name similarity" }],
		});

		expect(result.content).not.toContain("<nearby");
		expect(result.content).toContain("ignored=1; skipped=2");
		expect(result.details.nearby).toBeUndefined();
		expect(result.details.outputTruncated).toBe(false);
		expect(countTextTokensSync(result.content).tokens).toBeLessThanOrEqual(32);
	});

	it("重复路径融合时不修改输入候选", () => {
		const entry = createFindEntry("src/target.ts", "file");
		const lexical = { entry, tier: 3, evidence: createRankingEvidence("lexical", 0.8) };
		const structural = { entry, tier: 2, evidence: createRankingEvidence("structural", 0.6) };

		const merged = mergeRankedFindEntries(lexical, structural);

		expect(merged.tier).toBe(2);
		expect(merged.evidence.familyCount).toBe(2);
		expect(lexical.tier).toBe(3);
		expect(lexical.evidence.familyCount).toBe(1);
	});
});
