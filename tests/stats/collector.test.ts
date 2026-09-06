import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collectTools } from "../../src/stats/collector.js";
import { summarizeUsage } from "../../src/stats/usage.js";
import { assistantToolCall, toolResult, userMessage } from "./message-fixtures.js";

describe("stats collector", () => {
	it("空会话不产生费用或命中率，最后一轮零用量清除当前命中率", () => {
		expect(summarizeUsage([])).toEqual({
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalObservedTokens: 0 },
			cache: {},
		});
		const { usage, cache } = summarizeUsage([
			assistant("cached", { input: 100, output: 10, cacheRead: 100, cacheWrite: 0, total: 210, cost: 1 }),
			assistant("empty", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }),
		]);
		expect(usage.costUsd).toBe(1);
		expect(usage).not.toHaveProperty("lastCostUsd");
		expect(cache).toEqual({ totalHitRate: 50 });
	});

	it("从 assistant usage 汇总 token、成本和 cache", () => {
		const messages: Message[] = [
			userMessage("hello"),
			assistant("a1", { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 500, total: 4700, cost: 0.01 }),
			assistant("a2", { input: 2000, output: 300, cacheRead: 6000, cacheWrite: 1000, total: 9300, cost: 0.02 }),
		];

		const { usage, cache } = summarizeUsage(messages);

		expect(usage).toMatchObject({
			inputTokens: 3000,
			outputTokens: 500,
			cacheReadTokens: 9000,
			cacheWriteTokens: 1500,
			totalObservedTokens: 14000,
			lastTurnTokens: 9300,
			averageTokensPerAssistantTurn: 7000,
			costUsd: 0.03,
			lastCostUsd: 0.02,
		});
		expect(cache.latestHitRate).toBeCloseTo(66.666, 2);
		expect(cache.totalHitRate).toBeCloseTo(66.666, 2);
		expect(cache.readWriteRatio).toBe(6);
	});

	it("从公开 message 内容统计工具调用和失败", () => {
		const messages: Message[] = [
			assistantToolCall("read", { path: "a.ts" }),
			toolResult("read", "content", false),
			assistantToolCall("bash", { cmd: "false" }),
			toolResult("bash", "failed", true),
		];

		const stats = collectTools(messages, 2, 4);

		expect(stats).toMatchObject({ activeCount: 2, totalCount: 4, calls: 2, successes: 1, failures: 1 });
		expect(stats.byName).toEqual([
			{ name: "bash", calls: 1, failures: 1, outputChars: 6 },
			{ name: "read", calls: 1, outputChars: 7 },
		]);
	});
});

function assistant(text: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number }): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.total,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}
