import { outputPreview } from "../../messages.ts";
import { memo } from "react";
import { useDisclosureMemory } from "../components/disclosure-memory.ts";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { Disclosure } from "../components/disclosure";
import { errorSummary } from "./tool-display.tsx";
import { ToolSummary } from "./tool-summary.tsx";
import { CodemodeActivity } from "./codemode-activity.tsx";
import { clean } from "../content/content.tsx";
import { ToolBody } from "./tool-body.tsx";
import { ParameterValue } from "./tool-parameters.tsx";
import { sameToolActivity, type ToolActivity as Activity } from "../transcript/transcript-items.ts";
import { toolTarget } from "./tool-target.ts";
import { SkillCard } from "../content/skill-card.tsx";
import { isSkillLoadDetails } from "../../skill-facts.ts";

export const ToolActivity = memo(function ToolActivity({ tool }: { tool: Activity }) {
	return tool.name === "codemode" ? <CodemodeActivity tool={tool} /> : <StandardToolActivity tool={tool} />;
}, (before, after) => sameToolActivity(before.tool, after.tool));

function StandardToolActivity({ tool }: { tool: Activity }) {
	const [expanded, setExpanded] = useDisclosureMemory(`tool:${tool.id}`, null);
	const output = outputPreview(tool.output);
	if (tool.name === "skill") return <SkillCard id={tool.id} name={isSkillLoadDetails(output?.details) ? output.details.name : toolTarget(tool.name, tool.args)}
		loadedBy="agent" state={tool.state} output={tool.output} />;
	const open = expanded ?? (tool.name === "subagent" && tool.state === "running");
	const active = tool.state === "running" || tool.state === "preparing";
	const error = tool.state === "failed" ? errorSummary(tool) : "";
	return (
		<section className="tool-activity" data-state={tool.state} data-tool={tool.name} data-tool-call-id={tool.id}>
			<Collapsible open={open} onOpenChange={setExpanded}>
			<ToolSummary tool={tool} open={open} />
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
