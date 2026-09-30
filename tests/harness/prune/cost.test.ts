import { describe, expect, it } from "vitest";
import { buildPruneCostPreview, getLastUsage, getUsageContextTokens } from "../../../src/harness/prune/prune.ts";
import { assistant, solModel, ZERO_USAGE } from "./fixtures.ts";

describe("裁剪成本", () => {
	it("提供方只返回分项 usage 时仍计入完整上下文", () => {
		const usage = { ...ZERO_USAGE, input: 100, output: 20, cacheRead: 300, cacheWrite: 4 };
		expect(getUsageContextTokens(usage)).toBe(424);
		expect(getLastUsage([assistant([], usage)])).toEqual(usage);
	});

	it.each([
		{ name: "保留缓存更便宜", fullTokens: 230255, prunedTokens: 40582, commonPrefixTokens: 2300, cacheableFullTokens: 229233, usesCacheWrite: false, keep: 0.1197265, prune: 0.19256, shouldPrune: false },
		{ name: "裁剪更便宜", fullTokens: 100000, prunedTokens: 10000, commonPrefixTokens: 2000, cacheableFullTokens: 100000, usesCacheWrite: false, keep: 0.05, prune: 0.041, shouldPrune: true },
	])("$name", (scenario) => {
		const result = buildPruneCostPreview({ model: solModel(), ...scenario });
		expect(result.shouldPrune).toBe(scenario.shouldPrune);
		expect(result.keepCostUsd).toBeCloseTo(scenario.keep);
		expect(result.pruneCostUsd).toBeCloseTo(scenario.prune);
	});

	it("低置信度不接受 10% 宽松条件，高输入量按价格档计算", () => {
		const input = { model: solModel(), fullTokens: 100000, prunedTokens: 99000, commonPrefixTokens: 97000, cacheableFullTokens: 99000, usesCacheWrite: true };
		expect(buildPruneCostPreview(input).shouldPrune).toBe(true);
		expect(buildPruneCostPreview({ ...input, tokenConfidence: "low" })).toMatchObject({ shouldPrune: false, closeRatio: 0 });
		const tiered = buildPruneCostPreview({
			...input, prunedTokens: 10000, commonPrefixTokens: 0, cacheableFullTokens: 100000,
			model: solModel({ inputTokensAbove: 50000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }),
		});
		expect(tiered.keepCostUsd).toBeCloseTo(0.1);
		expect(tiered.pruneCostUsd).toBeCloseTo(0.0625);
		expect(tiered).toMatchObject({ shouldPrune: true, missPricing: "cache_write" });
	});
});
