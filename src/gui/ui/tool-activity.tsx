import { outputPreview } from "../messages.ts";
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
import { SkillCard } from "./skill-card.tsx";
import { isSkillLoadDetails } from "../skill-facts.ts";

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
	const output = outputPreview(tool.output);
	if (tool.name === "skill") return <SkillCard id={tool.id} name={isSkillLoadDetails(output?.details) ? output.details.name : toolTarget(tool.name, tool.args)}
		loadedBy="agent" state={tool.state} output={tool.output} />;
	const open = expanded ?? (tool.name === "subagent" && tool.state === "running");
	const definition = Object.hasOwn(tools, tool.name) ? tools[tool.name as keyof typeof tools] : { label: tool.name || "工具调用", icon: Wrench };
	const Icon = definition.icon;
	const active = tool.state === "running" || tool.state === "preparing";
	const Status = active ? LoaderCircle : tool.state === "completed" ? Check : tool.state === "failed" ? X
		: tool.state === "stopped" ? CircleStop : CircleDashed;
	const target = toolTarget(tool.name, tool.args);
	const facts = tool.output?.kind === "reference" ? tool.output.facts : toolFacts({ ...tool, output });
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
			{tool.nestedCalls && <Disclosure className="tool-nested" summary={`${tool.nestedCalls.calls.length} 次嵌套调用`} lazy>
				{tool.nestedCalls.calls.map((call) => <div key={call.id} data-nested-tool-call-id={call.id}>
					<strong>{call.name}</strong> · {call.status === "ok" ? "完成" : call.status === "error" ? "失败" : active ? "执行中" : "未完成"}
					{call.durationMs !== undefined && <span> · {call.durationMs} ms</span>}
					{call.arguments && <ParameterValue value={call.arguments} />}
					{call.error && <p role="alert">{clean(call.error)}</p>}
				</div>)}
				{!active && !tool.nestedCalls.complete && <p className="tool-note">嵌套记录不完整，部分参数、调用或完成状态未保留。</p>}
			</Disclosure>}
			<CollapsibleContent lazy={tool.name !== "subagent"}><ToolBody tool={tool} /></CollapsibleContent>
			</Collapsible>
		</section>
	);
}, (before, after) => before.tool.id === after.tool.id && before.tool.name === after.tool.name && before.tool.state === after.tool.state
	&& before.tool.args === after.tool.args && before.tool.output === after.tool.output && before.tool.nestedCalls === after.tool.nestedCalls);

function ToolBody({ tool }: { tool: Activity }) {
	const id = tool.output?.kind === "reference" ? tool.output.id : undefined;
	const loaded = useToolOutput(id);
	if (id && !loaded.value) return <p className="tool-note" role={loaded.error ? "alert" : "status"}>{loaded.error || "正在读取工具结果…"}</p>;
	const resolved = { ...tool, output: loaded.value ?? outputPreview(tool.output) };
	return <div className="activity-body">
		{tool.args !== undefined && <Disclosure className="tool-parameters" summary="参数" lazy><ParameterValue value={tool.args} /></Disclosure>}
		<ToolResult tool={resolved} />
		<Disclosure className="tool-raw" summary="原始数据" lazy><RawToolData args={tool.args} output={resolved.output} /></Disclosure>
	</div>;
}

const RawToolData = memo(function RawToolData({ args, output }: { args: unknown; output: import("../messages.ts").ToolOutput | undefined }) {
	return <pre>{pretty({ arguments: args, result: output })}</pre>;
});

function errorSummary(tool: Activity): string {
	const output = outputPreview(tool.output);
	const details = output?.details;
	if (record(details) && record(details.error) && typeof details.error.message === "string") return clean(details.error.message);
	const content = output?.content;
	if (Array.isArray(content)) {
		const first = content.find((block: unknown) => record(block) && block.type === "text");
		if (record(first) && typeof first.text === "string") return clean(first.text).split("\n").find((line) => line.trim()) ?? "";
	}
	return "";
}
