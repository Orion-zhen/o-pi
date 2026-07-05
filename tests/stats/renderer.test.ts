import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderStats } from "../../src/stats/render-stats.js";
import type { StatsSnapshot } from "../../src/stats/types.js";

describe("stats renderer", () => {
	it("宽屏显示完整 context breakdown 表格并限制宽度", () => {
		const lines = renderStats(snapshot(), 120);

		expect(lines.join("\n")).toContain("Context breakdown · current request window · ~estimated");
		expect(lines.join("\n")).toContain("source");
		expect(lines.join("\n")).toContain("conversation history");
		expect(lines.join("\n")).toContain("$0.084 est");
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("中等宽度使用短列名", () => {
		const output = renderStats(snapshot(), 80).join("\n");

		expect(output).toContain("source");
		expect(output).toContain("tokens");
		expect(output).toContain("history");
		expect(output).not.toContain("conversation history      ~33.4k");
	});

	it("Context breakdown 占比条自动折行且不截断后续项目", () => {
		const lines = renderStats(snapshot(), 80);
		const compactOutput = lines.join(" ").replace(/\s+/g, " ");

		expect(compactOutput).toContain("[ system 14.0% ]");
		expect(compactOutput).toContain("[ tool output 24.1% ]");
		expect(compactOutput).toContain("[ delta 2.3% ]");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("窄屏使用单列紧凑布局且隐藏 note", () => {
		const lines = renderStats(snapshot(), 56);
		const output = lines.join("\n");

		expect(output).toContain("Context · ~86k/200k · 43.2%");
		expect(output).toContain("history");
		expect(output).not.toContain("28 messages");
		expect(lines.every((line) => visibleWidth(line) <= 56)).toBe(true);
	});

	it("长内容自动折行且不丢失", () => {
		const data = snapshot();
		data.session.modelId = "provider-model-with-a-very-long-name-and-large-context-window";
		data.context.items[5] = {
			id: "unknown_delta",
			label: "unknown delta",
			tokens: 2000,
			share: 2.3,
			estimated: true,
			note: "provider overhead includes request serialization and tokenizer metadata",
		};
		data.tools.byName = [{ name: "very-long-tool-name-for-regression", calls: 3 }];

		const lines = renderStats(data, 80);
		const compactOutput = lines.join(" ").replace(/\s+/g, " ");

		expect(compactOutput).toContain("provider-model-with-a-very-long-name-and-large-context-window");
		expect(compactOutput).toContain("provider overhead includes request serialization and tokenizer metadata");
		expect(compactOutput).toContain("very-long-tool-name-for-regression");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});
});

function snapshot(): StatsSnapshot {
	return {
		session: {
			cwd: "/home/orion/repo/o-pi",
			git: "stats-ui*",
			modelId: "claude-sonnet",
			modelProvider: "anthropic",
			modelReasoning: true,
			thinkingLevel: "high",
			status: "ready",
			userTurns: 10,
			assistantTurns: 8,
		},
		usage: {
			inputTokens: 122000,
			outputTokens: 18000,
			cacheReadTokens: 310000,
			cacheWriteTokens: 44000,
			totalObservedTokens: 494000,
			lastTurnTokens: 21000,
			averageTokensPerAssistantTurn: 13700,
			costUsd: 0.084,
			lastCostUsd: 0.006,
		},
		cache: { latestHitRate: 84.1, totalHitRate: 70.3, readWriteRatio: 7.0 },
		context: {
			totalTokens: 86400,
			contextWindow: 200000,
			percent: 43.2,
			remainingTokens: 113600,
			confidence: "mixed",
			notes: [],
			items: [
				{ id: "system", label: "system prompt", tokens: 12100, share: 14, estimated: true, note: "custom prompt" },
				{ id: "tool_definitions", label: "tool definitions", tokens: 15500, share: 18, estimated: true, note: "12 active tools" },
				{ id: "project_context", label: "project context", tokens: 2600, share: 3, estimated: true, note: "AGENTS.md" },
				{ id: "conversation_history", label: "conversation history", tokens: 33400, share: 38.7, estimated: true, note: "28 messages" },
				{ id: "tool_outputs", label: "tool outputs", tokens: 20800, share: 24.1, estimated: true, note: "read / grep / bash" },
				{ id: "unknown_delta", label: "unknown delta", tokens: 2000, share: 2.3, estimated: true, note: "provider overhead" },
			],
		},
		tools: {
			activeCount: 12,
			totalCount: 14,
			calls: 37,
			successes: 35,
			failures: 2,
			byName: [
				{ name: "read", calls: 14 },
				{ name: "grep", calls: 7 },
				{ name: "edit", calls: 5 },
				{ name: "bash", calls: 4 },
			],
		},
		generatedAt: new Date("2026-07-05T00:00:00Z"),
	};
}
