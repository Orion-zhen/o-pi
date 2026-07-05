import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collectCache, collectTools, collectUsage } from "../../src/stats/collector.js";

describe("stats collector", () => {
	it("从 assistant usage 汇总 token、成本和 cache", () => {
		const messages: Message[] = [
			user("hello"),
			assistant("a1", { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 500, total: 4700, cost: 0.01 }),
			assistant("a2", { input: 2000, output: 300, cacheRead: 6000, cacheWrite: 1000, total: 9300, cost: 0.02 }),
		];

		const usage = collectUsage(messages);
		const cache = collectCache(messages, usage);

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
			assistantWithTool("read", { path: "a.ts" }),
			toolResult("read", "content", false),
			assistantWithTool("bash", { cmd: "false" }),
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

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

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

function assistantWithTool(name: string, args: Record<string, unknown>): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `${name}-1`, name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolName: string, text: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-1`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}
