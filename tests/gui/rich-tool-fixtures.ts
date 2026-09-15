import type { SubagentCompletedResult, SubagentDetails, SubagentRunResult } from "../../src/harness/subagent/types.ts";
import type { WebFetchSuccessDetails, WebSearchSuccessDetails } from "../../src/harness/web-tools/core/types.ts";

export const searchDetails: WebSearchSuccessDetails = {
	status: "success", query: "React streaming UI", provider: "brave_api", downloaded_bytes: 2048, duration_ms: 120, attempts: [],
	results: [
		{ rank: 1, title: "React 文档", url: "https://react.dev/learn?source=search", snippet: "了解组件与流式交互。" },
		{ rank: 2, title: "设计参考", url: "https://example.com/design", snippet: "让用户专注于最终回复。" },
	],
};
export const fetchDetails: WebFetchSuccessDetails = {
	status: "success", scope: "static_response", page_kind: "article", text_source: "readability", completeness: "partial",
	omissions: [{ kind: "interactive_content", reason: "client_rendered" }],
	requested_url: "https://react.dev/learn", final_url: "https://react.dev/learn", http_status: 200, title: "React 文档",
	format: "markdown", downloaded_bytes: 4096, total_chars: 6000,
	range: { kind: "read", start: 0, end: 2000, total: 6000, has_more: true, next_offset: 2000 },
	authenticated: false, redirect_count: 0, snapshot: "created", deferred_fragments: { discovered: 0, resolved: 0, limited: false },
	media: { discovered: 0, returned: 0 }, duration_ms: 250,
	preview: "## 组件与交互\n\n使用 **组件** 组织界面。[阅读文档](https://react.dev/learn)。\n\n![不自动加载](https://example.com/tracker.png)",
};
export const agentDetails: SubagentDetails = {
	mode: "parallel", runId: "gui-agents", tasks: [
		{ agent: "scout", task: "检查聊天布局" },
		{ agent: "scout", task: "检查流式状态" },
		{ agent: "reviewer", task: "检查回归测试" },
	], results: [], warnings: [],
};
export function agentRun(index: number, changes: Partial<Omit<SubagentRunResult, "status">> & ({ status?: "running" } | Pick<SubagentCompletedResult, "status" | "exitCode" | "outputFile">) = {}): SubagentRunResult {
	const task = agentDetails.tasks[index];
	if (!task) throw new Error("缺少测试任务");
	return {
		runId: agentDetails.runId, mode: agentDetails.mode, contextMode: "isolated", agent: task.agent, source: "user", task: task.task,
		cwd: "/workspace", model: "test/model", tools: ["read"], attempts: 1, output: "", durationMs: 1200,
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, contextTokens: 120, turns: 1 },
		events: [{ type: "tool", name: "read", args: { path: "src/gui/ui/main.tsx" }, status: "running" }],
		...(changes.status === "completed" ? changes : { ...changes, status: "running" }),
	};
}
