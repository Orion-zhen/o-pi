import { clean } from "../text.ts";
import { toolDetails, type ToolDetails } from "./tool-details.ts";
import { subagentFacts } from "./tool-facts.ts";
import type { GuiToolResult, ToolOutput } from "./types.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classify(name: string, details: unknown): ToolDetails {
	switch (name) {
		case "read": if (toolDetails.read(details)) return { view: "read", details }; break;
		case "edit": case "write": if (toolDetails.diff(details)) return { view: "diff", details }; break;
		case "grep": if (toolDetails.grep(details)) return { view: "grep", details }; break;
		case "find": if (toolDetails.find(details)) return { view: "find", details }; break;
		case "ls": if (toolDetails.ls(details)) return { view: "ls", details }; break;
		case "subagent": if (toolDetails.subagent(details)) return { view: "subagent", details }; break;
		case "websearch": if (toolDetails.websearch(details)) return { view: "websearch", details }; break;
		case "webfetch": if (toolDetails.webfetch(details)) return { view: "webfetch", details }; break;
	}
	return { view: (name === "websearch" || name === "webfetch") && record(details) && details.status === "progress" ? "progress" : "raw" };
}

function facts(name: string, result: ToolDetails, details: Record<string, unknown>): string {
	switch (result.view) {
		case "subagent": return subagentFacts(result.details);
		case "websearch": return `${result.details.results.length} 个结果`;
		case "webfetch": return [result.details.http_status, result.details.format, result.details.completeness === "partial" ? "部分内容" : ""].filter(Boolean).join(" · ");
		case "progress": {
			const phases: Record<string, string> = { waiting: "等待搜索", requesting: "请求中", redirecting: "重定向中", downloading: "下载中", converting: "提取正文", parsing: "整理结果" };
			return [typeof details.phase === "string" ? phases[details.phase] : "", typeof details.received_bytes === "number" ? `${(details.received_bytes / 1024).toFixed(1)} KB` : ""].filter(Boolean).join(" · ");
		}
	}
	if (name === "read") {
		if (typeof details.total_lines === "number") return `${details.total_lines} 行`;
		if (typeof details.total_pages === "number") return `${details.total_pages} 页`;
		if (details.media_type === "image") return "图片";
	}
	if (name === "grep" && typeof details.returned_regions === "number") return `${details.returned_regions} 处结果`;
	if (name === "find" && typeof details.returned_matches === "number") return `${details.returned_matches} 项`;
	if (name === "ls" && result.view === "ls") return `${result.details.entries.length} 项`;
	if (result.view === "diff") {
		const lines = result.details.diff.split("\n");
		return `+${lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length} -${lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length}`;
	}
	if (name === "bash" && typeof details.exit_code === "number") return `退出 ${details.exit_code}`;
	return "";
}

/** 扩展和历史记录只在投影边界解析。不能识别的结构保留原始数据，不进入富展示。 */
export function projectToolOutput(name: string, output: ToolOutput): GuiToolResult {
	const details = record(output.details) ? output.details : {};
	const first = Array.isArray(output.content) ? output.content.find((block: unknown) => record(block) && block.type === "text" && typeof block.text === "string") : undefined;
	const error = record(details.error) && typeof details.error.message === "string" ? clean(details.error.message)
		: record(first) && typeof first.text === "string" ? clean(first.text).match(/[^\n]*\S[^\n]*/)?.[0] ?? "" : "";
	const result = classify(name, output.details);
	return { ...output, ...result, facts: facts(name, result, details), error, aborted: details.status === "aborted" };
}

