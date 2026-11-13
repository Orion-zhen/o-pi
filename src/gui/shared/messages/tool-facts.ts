import type { GuiSubagentDetails, GuiSubagentRun } from "./tool-details.ts";
import type { GuiToolResult, ToolState } from "./types.ts";

export function subagentTaskState(result: GuiSubagentRun | undefined, parent: ToolState): ToolState | "skipped" {
	if (result?.status === "completed") {
		if (result.stopReason === "aborted" || result.error === "subagent aborted") return "stopped";
		return result.error !== undefined || result.exitCode !== 0 ? "failed" : "completed";
	}
	if (parent === "stopped") return "stopped";
	if (parent === "running" || parent === "pending" || parent === "preparing") return result ? "running" : "pending";
	return result || parent === "unavailable" ? "unavailable" : "skipped";
}
export function subagentFacts(details: GuiSubagentDetails): string {
	let done = 0, failed = 0, stopped = 0;
	for (const result of details.results) {
		if (result.status === "completed") done++;
		const state = subagentTaskState(result, "running");
		if (state === "failed") failed++;
		if (state === "stopped") stopped++;
	}
	return [`${done}/${details.tasks.length} 已结束`, failed ? `${failed} 失败` : "", stopped ? `${stopped} 已停止` : ""].filter(Boolean).join(" · ");
}

export function toolFacts(tool: { name: string; args: unknown; output: GuiToolResult | undefined }): string {
	const args = tool.args;
	if (tool.name === "read" && typeof args === "object" && args !== null) {
		if ("lines" in args && typeof args.lines === "string") return `行 ${args.lines}`;
		if ("pages" in args && typeof args.pages === "string") return `页 ${args.pages}`;
	}
	return tool.output?.facts ?? "";
}
