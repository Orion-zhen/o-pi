import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSubagentCommandProgressAdapter } from "../../src/subagent/tui/adapter.js";
import { renderSubagentCall, renderSubagentCommandEntry, renderSubagentResult } from "../../src/subagent/tui/renderer.js";
import { pendingSubagentResult } from "../../src/subagent/progress.js";
import type { SubagentCompletedResult, SubagentDetails, SubagentRunningResult, UsageStats } from "../../src/subagent/types.js";

const workspace = path.resolve("workspace");
const outputFile = path.join(workspace, ".pi", "subagents", "runs", "run-1", "scout-1.md");

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("subagent renderer", () => {
	it("TUI progress adapter 独立创建并在 dispose 清理 widget", () => {
		const widgets: unknown[] = [];
		const adapter = createSubagentCommandProgressAdapter({
			getToolsExpanded: () => true,
			setWidget(_key, content) {
				widgets.push(content);
			},
		});
		const result = pendingSubagentResult([{ agent: "scout", task: "inspect" }]);

		adapter.onProgress({ phase: "starting", result });
		adapter.onProgress({ phase: "completed", result });
		adapter.dispose();

		expect(widgets).toEqual([expect.any(Function), undefined]);
	});

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

	it("调用卡隐藏，缺少执行结果时 partial result 保留 agent 与 task", () => {
		const call = renderSubagentCall(
			{ tasks: [{ agent: "scout", task: "inspect auth flow and tests" }] },
			theme,
			{ isPartial: false },
		).render(120).join("\n");
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "reviewer", task: "review changed tests" }],
			results: [],
			warnings: [],
		};

		const partial = renderSubagentResult(
			{ content: [{ type: "text", text: "starting" }], details },
			{ expanded: false, isPartial: true },
			theme as never,
		).render(120).join("\n");

		expect(call).toBe("");
		for (const value of ["reviewer", "review changed tests"]) expect(partial).toContain(value);
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

		expect(rendered).toContain("missing");
		expect(rendered).toContain("Unknown agent missing");
		expect(renderSubagentCommandEntry(undefined, false, theme as never)).toBeUndefined();
	});

	it("展开态展示 running subagent 的实时事件", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "scout", task: "inspect renderer" }],
			results: [
				runningResult({
					agent: "scout",
					task: "inspect renderer",
					output: "found renderer behavior",
					events: [
						{ type: "tool", name: "read", args: { path: "src/subagent/tui/renderer.ts" } },
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

		for (const value of ["scout", "read", "src/subagent/tui/renderer.ts", "found renderer behavior"]) {
			expect(rendered).toContain(value);
		}
		expect(rendered.match(/found renderer behavior/g)).toHaveLength(1);
	});

	it("展开态从 details 展示完整输出，不依赖模型可见 content", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "scout", task: "inspect output" }],
			results: [
				completedResult({
					agent: "scout",
					task: "inspect output",
					output: "full subagent output kept for the tool card",
					outputFile,
				}),
			],
			warnings: [],
		};

		const rendered = renderSubagentResult(
			{ content: [{ type: "text", text: `Subagent scout produced too much output for inline return; full output saved to ${outputFile}.` }], details },
			{ expanded: true, isPartial: false },
			theme as never,
		).render(160).join("\n");

		expect(rendered).toContain(path.join(".pi", "subagents", "runs", "run-1", "scout-1.md"));
		expect(rendered).toContain("full subagent output kept for the tool card");
	});

	it("最终回答只出现在 Result，不在 Activity 重复", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			runId: "run-1",
			tasks: [{ agent: "scout", task: "inspect" }],
			results: [completedResult({
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

		expect(rendered).toContain("read");
		expect(rendered).toContain("src/a.ts");
		expect(rendered.match(/final answer/g)).toHaveLength(1);
	});
});

function completedResult(overrides: Partial<SubagentCompletedResult>): SubagentCompletedResult {
	return {
		status: "completed",
		runId: "run-1",
		mode: "parallel",
		contextMode: "isolated",
		agent: "scout",
		source: "user",
		task: "inspect",
		cwd: workspace,
		tools: ["read"],
		exitCode: 0,
		output: "done",
		outputFile,
		durationMs: 10,
		usage: usage(),
		events: [],
		...overrides,
	};
}

function runningResult(overrides: Partial<SubagentRunningResult>): SubagentRunningResult {
	return {
		status: "running",
		runId: "run-1",
		mode: "parallel",
		contextMode: "isolated",
		agent: "scout",
		source: "user",
		task: "inspect",
		cwd: workspace,
		tools: ["read"],
		output: "",
		durationMs: 0,
		usage: usage(),
		events: [],
		...overrides,
	};
}

function usage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
}
