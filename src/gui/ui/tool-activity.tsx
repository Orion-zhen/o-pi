import { memo } from "react";
import { useDisclosureMemory } from "./disclosure-memory.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { Disclosure } from "./components/disclosure";
import { Bot, Check, ChevronRight, CircleDashed, CircleStop, FilePenLine, FileSearch, FolderSearch, Globe, LoaderCircle, Search, Terminal, Wrench, X } from "lucide-react";
import { clean, pretty, record } from "./content.tsx";
import { ToolResult } from "./tool-results.tsx";
import { ParameterValue } from "./tool-parameters.tsx";
import type { ToolActivity as Activity, ToolState } from "./transcript-items.ts";
import { toolTarget } from "./tool-target.ts";
import { toolFacts } from "../tool-facts.ts";
import { useToolOutput } from "./payload.tsx";

const states: Record<ToolState, string> = {
	preparing: "生成参数", pending: "等待执行", running: "执行中", completed: "完成", failed: "执行失败", stopped: "已停止", unavailable: "无执行结果",
};
const tools = {
	read: { label: "读取", icon: FileSearch }, grep: { label: "搜索", icon: Search }, find: { label: "查找", icon: FolderSearch },
	ls: { label: "列出", icon: FolderSearch }, edit: { label: "修改", icon: FilePenLine }, write: { label: "写入", icon: FilePenLine },
	subagent: { label: "子代理", icon: Bot },
	bash: { label: "运行", icon: Terminal }, websearch: { label: "搜索网页", icon: Globe }, webfetch: { label: "读取网页", icon: Globe },
};

export const ToolActivity = memo(function ToolActivity({ tool }: { tool: Activity }) {
	const [expanded, setExpanded] = useDisclosureMemory(`tool:${tool.id}`, null);
	const open = expanded ?? (tool.name === "subagent" && tool.state === "running");
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
			<Collapsible open={open} onOpenChange={setExpanded}>
			<CollapsibleTrigger className="activity-summary">
				<Icon className="activity-icon" aria-hidden="true" />
				<span className="activity-label">{definition.label}</span>
				<code className="activity-target" title={target}>{target}</code>
				{facts && <span className="activity-facts" title={facts}>{facts}</span>}
				<span className="activity-state" title={states[tool.state]}>
					<Status className={active ? "animate-spin" : ""} aria-hidden="true" /><span>{states[tool.state]}</span>
				</span>
				<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
			</CollapsibleTrigger>
			{error && <p className="activity-error">{error}</p>}
			<CollapsibleContent lazy={tool.name !== "subagent"}><ToolBody tool={tool} /></CollapsibleContent>
			</Collapsible>
		</section>
	);
}, (before, after) => before.tool.id === after.tool.id && before.tool.name === after.tool.name && before.tool.state === after.tool.state
	&& before.tool.args === after.tool.args && before.tool.output === after.tool.output);

function ToolBody({ tool }: { tool: Activity }) {
	const details = tool.output?.details;
	const id = record(details) && typeof details.guiOutputId === "string" ? details.guiOutputId : undefined;
	const loaded = useToolOutput(id);
	if (id && !loaded.value) return <p className="tool-note" role={loaded.error ? "alert" : "status"}>{loaded.error || "正在读取工具结果…"}</p>;
	const resolved = loaded.value ? { ...tool, output: loaded.value } : tool;
	return <div className="activity-body">
		{tool.args !== undefined && <Disclosure className="tool-parameters" summary="参数" lazy><ParameterValue value={tool.args} /></Disclosure>}
		<ToolResult tool={resolved} />
		<Disclosure className="tool-raw" summary="原始数据" lazy><RawToolData args={tool.args} output={resolved.output} /></Disclosure>
	</div>;
}

const RawToolData = memo(function RawToolData({ args, output }: Pick<Activity, "args" | "output">) {
	return <pre>{pretty({ arguments: args, result: output })}</pre>;
});

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
