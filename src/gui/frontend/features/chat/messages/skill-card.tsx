import { outputPreview } from "../../../../shared/messages/output.ts";
import { BookOpen, ChevronRight } from "lucide-react";
import { ActivityIcon } from "../tools/tool-display.tsx";
import type { SkillLoadDetails } from "../../../../../harness/skill-context/types.ts";
import { isSkillLoadDetails, skillLoaders, skillScopes } from "../../../../shared/messages/skill-facts.ts";
import type { ToolActivity } from "../tools/activity.ts";
import type { ToolState } from "../../../../shared/messages/types.ts";
import { Content } from "./content.tsx";
import { MarkdownText } from "@/ui/content/markdown.tsx";
import { clean, pretty, record } from "@/ui/content/format.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { useDisclosureMemory } from "@/ui/disclosure-memory.ts";
import { useToolOutput } from "../tools/use-tool-output.ts";
import "./skills.css";

type SkillCardProps = Pick<ToolActivity, "id" | "state" | "output"> & { name: string; loadedBy: SkillLoadDetails["loadedBy"] };
const states: Record<ToolState, string> = {
	preparing: "生成参数", pending: "等待加载", running: "加载中", completed: "", failed: "加载失败", stopped: "已停止", unavailable: "无加载结果",
};

export function SkillCard({ id, name, loadedBy, state, output }: SkillCardProps) {
	const [open, setOpen] = useDisclosureMemory(`skill:${id}`, false);
	const preview = outputPreview(output);
	const details = isSkillLoadDetails(preview?.details) ? preview.details : undefined;
	const status = state === "completed" && details?.deduplicated ? "已加载过" : states[state];
	const error = state === "failed" && record(preview?.details) && record(preview.details.error) && typeof preview.details.error.message === "string"
		? clean(preview.details.error.message) : "";
	return <section className="tool-activity skill-activity" data-tool="skill" data-state={state} data-tool-call-id={loadedBy === "agent" ? id : undefined}>
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="activity-summary">
				<BookOpen className="activity-icon" aria-hidden="true" />
				<span className="activity-label">技能</span>
				<code className="activity-target">{name}</code>
				<span className="skill-loader">{skillLoaders[loadedBy]}</span>
				<span className="activity-state" data-state={state}>{status && <span>{status}</span>}<ActivityIcon state={state} /></span>
				<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
			</CollapsibleTrigger>
			{error && <p className="activity-error">{error}</p>}
			<CollapsibleContent lazy><SkillBody output={output} /></CollapsibleContent>
		</Collapsible>
	</section>;
}

function SkillBody({ output }: Pick<SkillCardProps, "output">) {
	const id = output?.kind === "reference" ? output.id : undefined;
	const loaded = useToolOutput(id);
	if (id && !loaded.value) return <p className="tool-note" role={loaded.error ? "alert" : "status"}>{loaded.error || "正在读取技能正文…"}</p>;
	const resolved = loaded.value ?? outputPreview(output);
	const details = isSkillLoadDetails(resolved?.details) ? resolved.details : undefined;
	const content = resolved?.content;
	const text = typeof content === "string" ? content : Array.isArray(content)
		? content.flatMap((block: unknown) => record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
	const boundary = details ? `<invoked_skill root="${details.root}"/>` : "";
	const body = boundary && text.startsWith(boundary) ? text.slice(boundary.length).replace(/^\r?\n\r?\n/, "") : text;
	return <div className="activity-body">
		{details && <dl className="skill-metadata">
			<div><dt>来源</dt><dd>{skillScopes[details.scope]}</dd></div>
			<div><dt>根路径</dt><dd><code>{details.root}</code></dd></div>
		</dl>}
		{details?.deduplicated ? <p className="tool-note">已加载过，本次未重复注入正文。</p>
			: <div className="message skill-body">{details ? <MarkdownText text={body} /> : <Content value={content} />}</div>}
		{resolved && <Disclosure className="tool-raw" summary="原始数据与内容哈希" lazy><pre>{pretty(resolved)}</pre></Disclosure>}
	</div>;
}
