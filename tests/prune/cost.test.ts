import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	buildPruneCostPreview,
	getLastUsage,
	getUsageContextTokens,
} from "../../src/prune/prune.js";
import { assistant, solModel, ZERO_USAGE } from "./fixtures.js";

describe("prune cost", () => {
	it("usage totalTokens 为 0 时回退到分项 token", () => {
		const usage: Usage = {
			...ZERO_USAGE,
			input: 100,
			output: 20,
			cacheRead: 300,
			cacheWrite: 4,
		};

		expect(getUsageContextTokens(usage)).toBe(424);
		expect(getLastUsage([assistant([], usage)])).toEqual(usage);
	});

	it("按当前会话样本的价格判断下一次请求保留缓存更便宜", () => {
		const preview = buildPruneCostPreview({
			model: solModel(),
			fullTokens: 230_255,
			prunedTokens: 40_582,
			commonPrefixTokens: 2_300,
			cacheableFullTokens: 229_233,
			usesCacheWrite: false,
		});

		expect(preview.keepCostUsd).toBeCloseTo(0.1197265);
		expect(preview.pruneCostUsd).toBeCloseTo(0.19256);
		expect(preview.shouldPrune).toBe(false);
		expect(preview.missPricing).toBe("input");
	});

	it("低置信度估算取消 10% 宽松条件", () => {
		const input = {
			model: solModel(),
			fullTokens: 100_000,
			prunedTokens: 99_000,
			commonPrefixTokens: 97_000,
			cacheableFullTokens: 99_000,
			usesCacheWrite: true,
		};

		const highConfidence = buildPruneCostPreview(input);
		const lowConfidence = buildPruneCostPreview({ ...input, tokenConfidence: "low" });

		expect(highConfidence.pruneCostUsd).toBeGreaterThan(highConfidence.keepCostUsd);
		expect(highConfidence.pruneCostUsd).toBeLessThanOrEqual(highConfidence.keepCostUsd * 1.1);
		expect(highConfidence.shouldPrune).toBe(true);
		expect(lowConfidence.closeRatio).toBe(0);
		expect(lowConfidence.tokenConfidence).toBe("low");
		expect(lowConfidence.shouldPrune).toBe(false);
	});

	it("裁剪成本更低或在 10% 内时执行，并按请求总输入选择价格档", () => {
		const lower = buildPruneCostPreview({
			model: solModel(),
			fullTokens: 100_000,
			prunedTokens: 10_000,
			commonPrefixTokens: 2_000,
			cacheableFullTokens: 100_000,
			usesCacheWrite: false,
		});
		const tiered = buildPruneCostPreview({
			model: solModel({ inputTokensAbove: 50_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }),
			fullTokens: 100_000,
			prunedTokens: 10_000,
			commonPrefixTokens: 0,
			cacheableFullTokens: 100_000,
			usesCacheWrite: true,
		});

		expect(lower.shouldPrune).toBe(true);
		expect(lower.pruneCostUsd).toBeLessThan(lower.keepCostUsd);
		expect(tiered.keepCostUsd).toBeCloseTo(0.1);
		expect(tiered.pruneCostUsd).toBeCloseTo(0.0625);
		expect(tiered.missPricing).toBe("cache_write");
		expect(tiered.shouldPrune).toBe(true);
	});
});
