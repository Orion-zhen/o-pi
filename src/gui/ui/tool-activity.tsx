import { outputPreview } from "../messages.ts";
import { memo } from "react";
import { useDisclosureMemory } from "./disclosure-memory.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { Disclosure } from "./components/disclosure";
import { ChevronRight } from "lucide-react";
import { ActivityState, errorSummary, toolDisplay } from "./tool-display.tsx";
import { CodemodeActivity } from "./codemode-activity.tsx";
import { clean, pretty } from "./content.tsx";
import { ToolResult } from "./tool-results.tsx";
import { ParameterValue } from "./tool-parameters.tsx";
import type { ToolActivity as Activity } from "./transcript-items.ts";
import { toolTarget } from "./tool-target.ts";
import { toolFacts } from "../tool-facts.ts";
import { useToolOutput } from "./payload.tsx";
import { SkillCard } from "./skill-card.tsx";
import { isSkillLoadDetails } from "../skill-facts.ts";

export const ToolActivity = memo(function ToolActivity({ tool }: { tool: Activity }) {
	return tool.name === "codemode" ? <CodemodeActivity tool={tool} /> : <StandardToolActivity tool={tool} />;
}, (before, after) => before.tool.id === after.tool.id && before.tool.name === after.tool.name && before.tool.state === after.tool.state
	&& before.tool.args === after.tool.args && before.tool.output === after.tool.output && before.tool.nestedCalls === after.tool.nestedCalls);

function StandardToolActivity({ tool }: { tool: Activity }) {
	const [expanded, setExpanded] = useDisclosureMemory(`tool:${tool.id}`, null);
	const output = outputPreview(tool.output);
	if (tool.name === "skill") return <SkillCard id={tool.id} name={isSkillLoadDetails(output?.details) ? output.details.name : toolTarget(tool.name, tool.args)}
		loadedBy="agent" state={tool.state} output={tool.output} />;
	const open = expanded ?? (tool.name === "subagent" && tool.state === "running");
	const definition = toolDisplay(tool.name);
	const Icon = definition.icon;
	const active = tool.state === "running" || tool.state === "preparing";
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
				<ActivityState state={tool.state} />
				<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
			</CollapsibleTrigger>
			{error && <p className="activity-error">{error}</p>}
			{tool.nestedCalls && <Disclosure className="tool-nested" summary={`${tool.nestedCalls.calls.length} 次嵌套调用`} lazy>
				{tool.nestedCalls.calls.map((call) => <div key={call.id} data-nested-tool-call-id={call.id}>
					<strong>{call.name}</strong> · {call.status === "ok" ? "完成" : call.status === "error" ? "失败" : active ? "执行中" : "未完成"}
					{call.durationMs !== undefined && <span> · {call.durationMs} ms</span>}
					{call.arguments !== undefined && <ParameterValue value={call.arguments} />}
					{call.error && <p role="alert">{clean(call.error)}</p>}
				</div>)}
				{!active && !tool.nestedCalls.complete && <p className="tool-note">嵌套记录不完整，部分参数、调用或完成状态未保留。</p>}
			</Disclosure>}
			<CollapsibleContent lazy={tool.name !== "subagent"}><ToolBody tool={tool} /></CollapsibleContent>
			</Collapsible>
		</section>
	);
}

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
