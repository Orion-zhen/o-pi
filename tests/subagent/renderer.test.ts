import { describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentCommandEntry, renderSubagentResult } from "../../src/subagent/renderer.js";
import type { SubagentDetails, SubagentRunResult, UsageStats } from "../../src/subagent/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("subagent renderer", () => {
	it("运行中和完成后隐藏调用卡，避免和 result card 重复", () => {
		const running = renderSubagentCall(
			{ tasks: [{ agent: "scout", task: "inspect auth flow and tests" }] },
			theme,
			{ isPartial: true },
		).render(120);
		const finished = renderSubagentCall(
			{ tasks: [{ agent: "scout", task: "inspect auth flow and tests" }] },
			theme,
			{ isPartial: false },
		).render(120);

		expect(running.join("")).toBe("");
		expect(finished.join("")).toBe("");
	});

	it("缺少 partial 上下文时调用卡仍可 fallback 展示 agent 和 task", () => {
		const rendered = renderSubagentCall(
			{ tasks: [{ agent: "scout", task: "inspect auth flow and tests" }] },
			theme,
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

	it("手动命令最终 entry 复用工具卡，并明确展示启动前失败", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "missing", task: "inspect" }],
			results: [],
			warnings: [],
		};
		const rendered = renderSubagentCommandEntry(
			{ content: [{ type: "text", text: "Unknown agent missing" }], details },
			true,
			theme as never,
		)?.render(120).join("\n");

		expect(rendered).toContain("missing · failed");
		expect(rendered).toContain("Unknown agent missing");
		expect(renderSubagentCommandEntry(undefined, false, theme as never)).toBeUndefined();
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

		expect(rendered).toContain("● scout  running");
		expect(rendered).toContain("Activity");
		expect(rendered).toContain("→ read");
		expect(rendered).toContain("found renderer behavior");
	});

	it("展开态从 details 展示完整输出，不依赖模型可见 content", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "scout", task: "inspect output" }],
			results: [
				result({
					agent: "scout",
					task: "inspect output",
					output: "full subagent output kept for the tool card",
					outputFile: "/workspace/.pi/subagents/runs/run-1/scout-1.md",
				}),
			],
			warnings: [],
		};

		const rendered = renderSubagentResult(
			{ content: [{ type: "text", text: "Subagent scout produced too much output for inline return; full output saved to /workspace/.pi/subagents/runs/run-1/scout-1.md." }], details },
			{ expanded: true, isPartial: false },
			theme as never,
		).render(160).join("\n");

		expect(rendered).toContain("Saved   .pi/subagents/runs/run-1/scout-1.md");
		expect(rendered).toContain("Result");
		expect(rendered).toContain("full subagent output kept for the tool card");
	});

	it("最终回答只出现在 Result，不在 Activity 重复", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "scout", task: "inspect" }],
			results: [result({
				output: "final answer",
				events: [
					{ type: "tool", name: "read", args: { path: "src/a.ts" } },
					{ type: "text", text: "final answer" },
				],
			})],
			warnings: [],
		};

		const rendered = renderSubagentResult(
			{ content: [{ type: "text", text: "final answer" }], details },
			{ expanded: true, isPartial: false },
			theme as never,
		).render(120).join("\n");

		expect(rendered).toContain("Activity");
		expect(rendered).toContain("→ read");
		expect(rendered).toContain("Result");
		expect(rendered.match(/final answer/g)).toHaveLength(1);
	});
});

function result(overrides: Partial<SubagentRunResult>): SubagentRunResult {
	return {
		runId: "run-1",
		mode: "parallel",
		contextMode: "isolated",
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
