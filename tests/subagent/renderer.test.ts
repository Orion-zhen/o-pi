import { describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "../../src/subagent/renderer.js";
import type { SubagentDetails, SubagentRunResult, UsageStats } from "../../src/subagent/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("subagent renderer", () => {
	it("折叠调用卡第一行展示 agent，第二行展示 task", () => {
		const rendered = renderSubagentCall(
			{ tasks: [{ agent: "scout", task: "inspect auth flow and tests" }] },
			theme,
			{ isPartial: true },
		).render(120);

		expect(rendered).toHaveLength(2);
		expect(rendered[0]).toContain("scout");
		expect(rendered[1]).toContain("inspect auth flow and tests");
	});

	it("无结果的 partial result 仍按 task 渲染折叠卡", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "reviewer", task: "review changed tests" }],
			results: [],
			warnings: [],
		};

		const rendered = renderSubagentResult(
			{ content: [{ type: "text", text: "starting" }], details },
			{ expanded: false, isPartial: true },
			theme as never,
		).render(120);

		expect(rendered).toHaveLength(2);
		expect(rendered[0]).toContain("reviewer");
		expect(rendered[1]).toContain("review changed tests");
	});

	it("展开态展示 running subagent 的实时事件", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "scout", task: "inspect renderer" }],
			results: [
				result({
					agent: "scout",
					task: "inspect renderer",
					exitCode: -1,
					events: [
						{ type: "tool", name: "read", args: { path: "src/subagent/renderer.ts" } },
						{ type: "text", text: "found renderer behavior" },
					],
				}),
			],
			warnings: [],
		};

		const rendered = renderSubagentResult(
			{ content: [{ type: "text", text: "running" }], details },
			{ expanded: true, isPartial: true },
			theme as never,
		).render(160).join("\n");

		expect(rendered).toContain("● scout · running");
		expect(rendered).toContain("events:");
		expect(rendered).toContain("-> read");
		expect(rendered).toContain("found renderer behavior");
	});
});

function result(overrides: Partial<SubagentRunResult>): SubagentRunResult {
	return {
		runId: "run-1",
		mode: "parallel",
		agent: "scout",
		source: "user",
		task: "inspect",
		cwd: "/workspace",
		tools: ["read"],
		attempts: 1,
		exitCode: 0,
		durationMs: 10,
		usage: usage(),
		events: [],
		...overrides,
	};
}

function usage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
}
