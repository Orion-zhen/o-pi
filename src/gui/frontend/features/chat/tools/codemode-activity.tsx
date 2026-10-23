import { ChevronRight, CodeXml } from "lucide-react";
import { outputPreview } from "../../../../shared/messages/output.ts";
import type { GuiNestedCall, ToolState } from "../../../../shared/messages/types.ts";
import { ActivityError, ActivityState, errorSummary } from "./tool-display.tsx";
import { useDisclosureMemory } from "@/ui/disclosure-memory.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { record } from "@/ui/content/format.ts";
import { ParameterValue } from "./tool-parameters.tsx";
import { RawToolContent } from "./tool-results.tsx";
import { ToolBody } from "./tool-body.tsx";
import { ToolSummary } from "./tool-summary.tsx";
import { useToolOutput } from "./use-tool-output.ts";
import type { ToolActivity } from "./activity.ts";

export function CodemodeActivity({ tool }: { tool: ToolActivity }) {
	const [expanded, setExpanded] = useDisclosureMemory(`tool:${tool.id}`, null);
	const active = tool.state === "running" || tool.state === "preparing" || tool.state === "pending";
	const open = expanded ?? (active || tool.state === "failed");
	const calls = tool.nestedCalls?.calls ?? [];
	const failures = calls.filter((call) => call.status === "error").length;
	const error = tool.state === "failed" ? errorSummary(tool) : "";
	return <section className="tool-activity codemode-activity" data-state={tool.state} data-tool="codemode" data-tool-call-id={tool.id}>
		<Collapsible open={open} onOpenChange={setExpanded}>
			<CollapsibleTrigger className="activity-summary">
				<CodeXml className="activity-icon" aria-hidden="true" /><span className="activity-label">codemode</span>
				<span className="activity-tail">
					<ActivityState state={tool.state} label={tool.state === "completed" ? "脚本完成" : undefined} durationMs={tool.durationMs}
						facts={<>{tool.nestedCalls ? `${calls.length} 次调用` : "执行脚本"}{failures > 0 && <span className="nested-failures"> · {failures} 次失败</span>}</>} />
					<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
				</span>
			</CollapsibleTrigger>
			<ActivityError>{error}</ActivityError>
			<CollapsibleContent lazy>
				<div className="activity-body codemode-body">
					<div className="codemode-calls">
						{calls.map((call) => <NestedCallRow key={call.id} call={call} active={active} stopped={tool.state === "stopped"} />)}
					</div>
					{!active && tool.nestedCalls?.complete === false && <p className="tool-note">调用记录不完整，部分参数、调用或完成状态未保留。</p>}
					{record(tool.args) && typeof tool.args.code === "string" && <Disclosure className="tool-parameters" summary="脚本" lazy>
						<CodeBlock label="JavaScript" language="javascript" text={tool.args.code} />
					</Disclosure>}
					{!active && tool.output && <Disclosure className="tool-parameters codemode-output" summary="输出给模型" lazy>
						<CodemodeOutput tool={tool} />
					</Disclosure>}
				</div>
			</CollapsibleContent>
		</Collapsible>
	</section>;
}

function NestedCallRow({ call, active, stopped }: { call: GuiNestedCall; active: boolean; stopped: boolean }) {
	const [expanded, setExpanded] = useDisclosureMemory(`nested:${call.id}`, null);
	const state: ToolState = call.status === "ok" ? "completed" : call.status === "error" ? "failed"
		: active ? "running" : stopped ? "stopped" : "unavailable";
	const tool: ToolActivity = { id: call.id, name: call.name, args: call.arguments, state, output: call.output, ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }) };
	const open = expanded ?? state === "failed";
	const error = call.status === "error" ? errorSummary(call) : "";
	return <Collapsible className="tool-activity nested-tool-call" data-nested-tool-call-id={call.id} data-state={state}
		open={open} onOpenChange={setExpanded}>
		<ToolSummary tool={tool} open={open} {...(state === "unavailable" ? { stateLabel: "未完成" } : {})} />
		<ActivityError>{error}</ActivityError>
		<CollapsibleContent lazy><div className="nested-call-details">
			{call.output ? <ToolBody tool={tool} /> : <div className="activity-body">
				{call.arguments !== undefined ? <Disclosure className="tool-parameters" summary="参数" lazy>
					<ParameterValue value={call.arguments} />
				</Disclosure> : <p className="tool-note">参数未保留{call.argumentsBytes !== undefined && `（${call.argumentsBytes} 字节）`}</p>}
				{state === "completed" && (call.name === "write" || call.name === "edit")
					&& <p className="tool-note">历史记录未保存变更结果。</p>}
			</div>}
		</div></CollapsibleContent>
	</Collapsible>;
}

function CodemodeOutput({ tool }: { tool: ToolActivity }) {
	const id = tool.output?.kind === "reference" ? tool.output.id : undefined;
	const loaded = useToolOutput(id);
	if (id && !loaded.value) return <p className="tool-note" role={loaded.error ? "alert" : "status"}>{loaded.error || "正在读取工具结果…"}</p>;
	const output = loaded.value ?? outputPreview(tool.output);
	return output ? <RawToolContent value={output.content} /> : null;
}
