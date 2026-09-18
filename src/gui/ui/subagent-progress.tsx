import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { Disclosure } from "./components/disclosure";
import Markdown from "react-markdown";
import { Bot, Check, ChevronRight, CircleDashed, CircleStop, LoaderCircle, X } from "lucide-react";
import type { SubagentDetails, SubagentRunResult, SubagentTask } from "../../harness/subagent/types.ts";
import { CodeBlock } from "./code-block.tsx";
import { MarkdownText, clean } from "./content.tsx";
import { subagentFacts, subagentTaskState as taskState } from "../tool-facts.ts";
import { ParameterValue } from "./tool-parameters.tsx";
import { toolTarget } from "./tool-target.ts";
import type { ToolState } from "./transcript-items.ts";

type TaskState = ToolState | "skipped";
const labels: Record<TaskState, string> = {
	preparing: "生成参数", pending: "等待执行", running: "执行中", completed: "完成", failed: "失败", stopped: "已停止", unavailable: "无完整结果", skipped: "未执行",
};

export function SubagentProgress({ details, state }: { details: SubagentDetails; state: ToolState }) {
	const done = details.results.filter((result) => result.status === "completed").length;
	const chainStopped = details.mode === "chain" && details.results.some((result) => result.status === "completed" && (result.error !== undefined || result.exitCode !== 0));
	return <div className="subagent-progress">
		<div className="subagent-overview"><Bot aria-hidden="true" /><span>{details.mode === "chain" ? "串行" : "并行"}</span><span>{subagentFacts(details)}</span></div>
		<progress value={done} max={details.tasks.length} aria-label="已结束的子任务" />
		<div className="subagent-tasks">{details.tasks.map((task, index) => {
			// 执行器按任务顺序启动并保留结果顺序，未启动任务位于尾部。
			const result = details.results[index];
			return <Task key={index} task={task} result={result} state={taskState(result, chainStopped ? "failed" : state)} />;
		})}</div>
		{details.warnings.map((warning, index) => <p className="tool-note" key={index}>{clean(warning)}</p>)}
	</div>;
}

function Task({ task, result, state }: { task: SubagentTask; result: SubagentRunResult | undefined; state: TaskState }) {
	const [expanded, setExpanded] = useState<boolean | null>(null);
	const open = expanded ?? state === "failed";
	const active = state === "running";
	const Icon = active ? LoaderCircle : state === "completed" ? Check : state === "failed" ? X : state === "stopped" ? CircleStop : CircleDashed;
	const latest = result?.events.at(-1);
	const current = latest?.type === "tool" ? `${latest.name} ${toolTarget(latest.name, latest.args)}` : result?.output;
	return <section className="subagent-task" data-state={state}>
		<Collapsible open={open} onOpenChange={setExpanded}>
		<CollapsibleTrigger className="subagent-task-summary">
			<span className="subagent-task-heading"><Icon className={active ? "animate-spin" : ""} aria-hidden="true" /><strong>{task.agent}</strong>
				<span className="subagent-task-state">{labels[state]}</span><ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
			</span>
			<span className="subagent-task-description">{task.task}</span>
			{current && !open && <span className="subagent-current">{latest?.type === "tool" ? clean(current)
				: <Markdown allowedElements={["strong", "em", "del", "code"]} unwrapDisallowed>{clean(current)}</Markdown>}</span>}
		</CollapsibleTrigger>
		{result?.error && <p className="subagent-error">{clean(result.error)}</p>}
		{result && <CollapsibleContent><div className="subagent-task-body">
			<p className="tool-note">{[result.model, `${(result.durationMs / 1000).toFixed(1)}s`, `${result.usage.turns} 轮`, result.attempts > 1 ? `${result.attempts} 次尝试` : ""].filter(Boolean).join(" · ")}</p>
			{result.output && <div className="message subagent-output"><MarkdownText text={result.output} /></div>}
			{result.events.length > 0 && <Disclosure className="subagent-events" summary="执行记录">
				{result.events.map((event, index) => event.type === "text"
					? event.text.trim() === result.output.trim() ? null : <div className="message" key={index}><MarkdownText text={event.text} /></div>
					: <Disclosure className="subagent-event" key={index} summary={<><code>{event.name} {toolTarget(event.name, event.args)}</code>
						<span>{event.status === "error" ? "失败" : event.status ? labels[event.status] : ""}</span>
					</>}><ParameterValue value={event.args} /></Disclosure>)}
			</Disclosure>}
			{result.stderr && <CodeBlock label="错误日志" text={clean(result.stderr)} />}
			{result.status === "completed" && <p className="tool-note">结果文件：<code>{result.outputFile}</code></p>}
		</div></CollapsibleContent>}
		</Collapsible>
	</section>;
}
