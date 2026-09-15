import { useState } from "react";
import { Bot, Check, ChevronRight, CircleDashed, CircleStop, FilePenLine, FileSearch, FolderSearch, Globe, LoaderCircle, Search, Terminal, Wrench, X } from "lucide-react";
import { clean, pretty, record } from "./content.tsx";
import { ToolResult } from "./tool-results.tsx";
import { ParameterValue } from "./tool-parameters.tsx";
import type { ToolActivity as Activity, ToolState } from "./transcript-items.ts";
import { toolTarget } from "./tool-target.ts";
import { webToolFacts } from "./web-results.tsx";
import { isSubagentDetails, subagentFacts } from "./subagent-progress.tsx";

const states: Record<ToolState, string> = {
	preparing: "生成参数", pending: "等待执行", running: "执行中", completed: "完成", failed: "执行失败", stopped: "已停止", unavailable: "无执行结果",
};
const tools = {
	read: { label: "读取", icon: FileSearch }, grep: { label: "搜索", icon: Search }, find: { label: "查找", icon: FolderSearch },
	ls: { label: "列出", icon: FolderSearch }, edit: { label: "修改", icon: FilePenLine }, write: { label: "写入", icon: FilePenLine },
	subagent: { label: "子代理", icon: Bot },
	bash: { label: "运行", icon: Terminal }, websearch: { label: "搜索网页", icon: Globe }, webfetch: { label: "读取网页", icon: Globe },
};

export function ToolActivity({ tool }: { tool: Activity }) {
	const [expanded, setExpanded] = useState<boolean | null>(null);
	const open = expanded ?? (tool.state === "failed" || tool.name === "subagent" && tool.state === "running");
	const definition = Object.hasOwn(tools, tool.name) ? tools[tool.name as keyof typeof tools] : { label: tool.name || "工具调用", icon: Wrench };
	const Icon = definition.icon;
	const active = tool.state === "running" || tool.state === "preparing";
	const Status = active ? LoaderCircle : tool.state === "completed" ? Check : tool.state === "failed" ? X
		: tool.state === "stopped" ? CircleStop : CircleDashed;
	const target = toolTarget(tool.name, tool.args);
	const facts = toolFacts(tool);
	const error = tool.state === "failed" ? errorSummary(tool) : "";
	return (
		<section className="tool-activity" data-state={tool.state} data-tool={tool.name} data-tool-call-id={tool.id}>
			<button className="activity-summary" type="button" aria-expanded={open} onClick={() => setExpanded(!open)}>
				<Icon className="activity-icon" aria-hidden="true" />
				<span className="activity-label">{definition.label}</span>
				<code className="activity-target" title={target}>{target}</code>
				{facts && <span className="activity-facts" title={facts}>{facts}</span>}
				<span className="activity-state" title={states[tool.state]}>
					<Status className={active ? "animate-spin" : ""} aria-hidden="true" /><span>{states[tool.state]}</span>
				</span>
				<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
			</button>
			{error && <p className="activity-error">{error}</p>}
			{(open || tool.name === "subagent" && tool.output) && <div className="activity-body" hidden={!open}>
				{tool.args !== undefined && <details className="tool-parameters">
					<summary>参数</summary><ParameterValue value={tool.args} />
				</details>}
				<ToolResult tool={tool} />
				<details className="tool-raw"><summary>原始数据</summary><pre>{pretty({ arguments: tool.args, result: tool.output })}</pre></details>
			</div>}
		</section>
	);
}

function toolFacts(tool: Activity): string {
	const args = record(tool.args) ? tool.args : {};
	const details = record(tool.output?.details) ? tool.output.details : {};
	if (tool.name === "websearch" || tool.name === "webfetch") return webToolFacts(details);
	if (tool.name === "subagent" && isSubagentDetails(details)) return subagentFacts(details);
	if (tool.name === "read") {
		if (typeof args.lines === "string") return `行 ${args.lines}`;
		if (typeof args.pages === "string") return `页 ${args.pages}`;
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

function errorSummary(tool: Activity): string {
	const details = tool.output?.details;
	if (record(details) && record(details.error) && typeof details.error.message === "string") return clean(details.error.message);
	const content = tool.output?.content;
	if (Array.isArray(content)) {
		const first = content.find((block: unknown) => record(block) && block.type === "text");
		if (record(first) && typeof first.text === "string") return clean(first.text).split("\n").find((line) => line.trim()) ?? "";
	}
	return "";
}
