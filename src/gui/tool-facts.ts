import type { WebFetchSuccessDetails, WebSearchSuccessDetails } from "../harness/web-tools/core/types.ts";
import type { SubagentDetails, SubagentRunResult } from "../harness/subagent/types.ts";
import type { ToolActivity, ToolState } from "./ui/transcript-items.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWebSearchSuccess(value: unknown): value is WebSearchSuccessDetails {
	return record(value) && value.status === "success" && typeof value.query === "string" && Array.isArray(value.results);
}
export function isWebFetchSuccess(value: unknown): value is WebFetchSuccessDetails {
	return record(value) && value.status === "success" && value.scope === "static_response"
		&& typeof value.final_url === "string" && typeof value.preview === "string" && record(value.range);
}
export function webToolFacts(details: unknown): string {
	if (isWebSearchSuccess(details)) return `${details.results.length} 个结果`;
	if (isWebFetchSuccess(details)) return [details.http_status, details.format, details.completeness === "partial" ? "部分内容" : ""].filter(Boolean).join(" · ");
	if (!record(details) || details.status !== "progress") return "";
	const phases: Record<string, string> = { waiting: "等待搜索", requesting: "请求中", redirecting: "重定向中", downloading: "下载中", converting: "提取正文", parsing: "整理结果" };
	if (typeof details.phase !== "string") return "";
	return [phases[details.phase], typeof details.received_bytes === "number" ? `${(details.received_bytes / 1024).toFixed(1)} KB` : ""].filter(Boolean).join(" · ");
}
export function isSubagentDetails(value: unknown): value is SubagentDetails {
	return record(value) && (value.mode === "parallel" || value.mode === "chain")
		&& Array.isArray(value.tasks) && value.tasks.length > 0 && Array.isArray(value.results) && Array.isArray(value.warnings);
}
export function subagentTaskState(result: SubagentRunResult | undefined, parent: ToolState): ToolState | "skipped" {
	if (result?.status === "completed") {
		if (result.stopReason === "aborted" || result.error === "subagent aborted") return "stopped";
		return result.error !== undefined || result.exitCode !== 0 ? "failed" : "completed";
	}
	if (parent === "stopped") return "stopped";
	if (parent === "running" || parent === "pending" || parent === "preparing") return result ? "running" : "pending";
	return result || parent === "unavailable" ? "unavailable" : "skipped";
}
export function subagentFacts(details: SubagentDetails): string {
	const done = details.results.filter((result) => result.status === "completed").length;
	const failed = details.results.filter((result) => subagentTaskState(result, "running") === "failed").length;
	const stopped = details.results.filter((result) => subagentTaskState(result, "running") === "stopped").length;
	return [`${done}/${details.tasks.length} 已结束`, failed > 0 ? `${failed} 失败` : "", stopped > 0 ? `${stopped} 已停止` : ""].filter(Boolean).join(" · ");
}

export function toolFacts(tool: Pick<ToolActivity, "name" | "args" | "output">): string {
	const args = record(tool.args) ? tool.args : {};
	const details = record(tool.output?.details) ? tool.output.details : {};
	if (tool.name === "read") {
		if (typeof args.lines === "string") return `行 ${args.lines}`;
		if (typeof args.pages === "string") return `页 ${args.pages}`;
	}
	if (typeof details.guiFacts === "string") return details.guiFacts;
	if (tool.name === "websearch" || tool.name === "webfetch") return webToolFacts(details);
	if (tool.name === "subagent" && isSubagentDetails(details)) return subagentFacts(details);
	if (tool.name === "read") {
		if (typeof details.total_lines === "number") return `${details.total_lines} 行`;
		if (typeof details.total_pages === "number") return `${details.total_pages} 页`;
		if (details.media_type === "image") return "图片";
	}
	if (tool.name === "grep" && typeof details.returned_regions === "number") return `${details.returned_regions} 处结果`;
	if (tool.name === "find" && typeof details.returned_matches === "number") return `${details.returned_matches} 项`;
	if (tool.name === "ls" && Array.isArray(details.entries)) return `${details.entries.length} 项`;
	if ((tool.name === "edit" || tool.name === "write") && typeof details.diff === "string") {
		const lines = details.diff.split("\n");
		return `+${lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length} -${lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length}`;
	}
	if (tool.name === "bash") {
		const parts: string[] = [];
		if (typeof details.exit_code === "number") parts.push(`退出 ${details.exit_code}`);
		if (typeof details.duration_ms === "number") parts.push(`${(details.duration_ms / 1000).toFixed(1)}s`);
		return parts.join(" · ");
	}
	return "";
}
