import { memo, useEffect, useId, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Reveal } from "@/ui/motion/animated.tsx";
import { useDisclosureMemory } from "@/ui/disclosure-memory.ts";
import { Disclosure } from "@/ui/disclosure.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { ChevronRight } from "lucide-react";
import { StreamingText } from "@/ui/content/markdown.tsx";
import { Message } from "../messages/message.tsx";
import { MessageIdentity, ReplyMetrics } from "../messages/message-meta.tsx";
import { MessageFooter } from "../messages/message-footer.tsx";
import { ToolActivity } from "../tools/tool-activity.tsx";
import { skillCount } from "./skill-summary.tsx";
import { ReplyStatusLabel } from "./reply-status-label.tsx";
import { sameTranscriptItem, type TranscriptItem } from "./transcript-items.ts";
import type { TranscriptReply } from "./transcript-replies.ts";

type TextItem = Extract<TranscriptItem, { kind: "text" }>;
type ActivityItem = Extract<TranscriptItem, { kind: "thinking" | "tool" }> & { showActions: boolean };
interface SectionContent { items: ActivityItem[]; entryIds: (string | undefined)[] }

function sameContent(before: SectionContent, after: SectionContent): boolean {
	return before.items.length === after.items.length && before.items.every((item, index) => {
		const next = after.items[index];
		return next !== undefined && item.showActions === next.showActions && sameTranscriptItem(item, next)
			&& before.entryIds[item.messageIndex] === after.entryIds[next.messageIndex];
	});
}
type Section = { key: string } & (
	| { kind: "body"; item: TextItem; showActions: boolean }
	| { kind: "activity"; items: ActivityItem[] }
	| { kind: "item"; item: TranscriptItem; showActions: boolean }
);

export function ReplyContent({ reply, entryIds }: { reply: TranscriptReply; entryIds: (string | undefined)[] }) {
	const id = useId();
	const [initialItems] = useState(() => new Set(reply.items.map((item) => item.key)));
	const running = reply.state === "running";
	const [open, setOpen] = useAutoFold(reply.key, running);
	const answers = new Set(reply.answer.map((item) => item.key));
	const hasAnswer = answers.size > 0;
	const activityOnly = reply.process.length > 0 && reply.process.every((item) => item.kind === "thinking" || item.kind === "tool");
	const tools = reply.process.filter((item) => item.kind === "tool");
	const thoughts = reply.process.filter((item) => item.kind === "thinking").length;
	const failures = tools.filter((item) => item.tool.state === "failed").length;
	const skills = skillCount(reply.process);
	const pruned = tools.some((item) => item.pruned);
	const counts = [
		thoughts ? `${thoughts} 段思考` : "",
		skills ? `${skills} 个技能` : "",
		tools.length ? `${tools.length} 次工具调用` : "",
		failures ? `${failures} 次失败` : "",
	].filter(Boolean).join(" · ");
	const targets = new Map<number, string>();
	for (const item of reply.items) targets.set(item.messageIndex, item.key);
	// 有正文的消息把操作放在最后一段正文下，否则放在最后一个过程片段下。
	for (const item of reply.items) if (item.kind === "text") targets.set(item.messageIndex, item.key);
	if (reply.lastAssistant && (!running || hasAnswer)) targets.delete(reply.lastAssistant.index);
	const sections: Section[] = [];
	for (const item of reply.items) {
		const showActions = targets.get(item.messageIndex) === item.key;
		const previous = sections.at(-1);
		if (item.kind === "text") sections.push({ key: item.key, kind: "body", item, showActions });
		else if (item.kind === "thinking" || item.kind === "tool") {
			const activity = { ...item, showActions };
			if (previous?.kind === "activity") previous.items.push(activity);
			else sections.push({ key: item.key, kind: "activity", items: [activity] });
		} else sections.push({ key: item.key, kind: "item", item, showActions });
	}
	const lastBody = sections.findLastIndex((section) => section.kind === "body");
	const processIds = sections.flatMap((section, index) => answers.has(section.key) ? [] : [`${id}-${index}`]);
	return <Collapsible className="reply-content" open={activityOnly || open} onOpenChange={setOpen}>
		<CollapsibleTrigger className="disclosure-trigger reply-process-trigger" aria-controls={processIds.join(" ")}
			hidden={activityOnly || !reply.process.length && (!running || hasAnswer)}>
			<ChevronRight className="disclosure-chevron" aria-hidden="true" />
			{pruned && <span className="reply-pruned-label">已裁剪</span>}
			<ReplyStatusLabel active={running}>{reply.retrying ? "正在重试" : "本轮过程"}</ReplyStatusLabel>
			{counts && <span className="reply-counts">{counts}</span>}
		</CollapsibleTrigger>
		<div className="reply-sections">{sections.map((section, index) => {
			const answer = answers.has(section.key);
			const continues = (neighbor: Section | undefined) => section.kind === "body" && neighbor?.kind === "body"
				&& neighbor.item.messageIndex === section.item.messageIndex && answers.has(neighbor.key) === answer;
			const first = !continues(sections[index - 1]);
			const last = !continues(sections[index + 1]);
			// 分类只改变可见性与样式，正文块始终保留原来的父节点和 key。
			return <Collapsible key={section.key} className={`reply-section ${answer ? "reply-answer" : "reply-process-section"}`}
				open={answer || activityOnly || open} data-tail={index === sections.length - 1 && (running || answer)}>
				<CollapsibleContent id={`${id}-${index}`}>
					{section.kind === "body" ? <ReplyBody item={section.item} entryId={entryIds[section.item.messageIndex]}
						first={first} last={last} showMetrics={!answer && last} showActions={section.showActions} />
						: section.kind === "activity" ? <Activity id={section.key} items={section.items} entryIds={entryIds}
							animateInitial={!initialItems.has(section.key)} tracking={running && !hasAnswer && index > lastBody} />
						: <Item item={section.item} entryId={entryIds[section.item.messageIndex]} showActions={section.showActions} />}
				</CollapsibleContent>
			</Collapsible>;
		})}</div>
	</Collapsible>;
}

const ReplyBody = memo(function ReplyBody({ item, entryId, first, last, showMetrics, showActions }: {
	item: TextItem; entryId: string | undefined; first: boolean; last: boolean; showMetrics: boolean; showActions: boolean;
}) {
	return <div className="reply-body" data-first={first} data-last={last}>
		{first && <MessageIdentity name={item.identity.model} timestamp={item.identity.timestamp} />}
		<Item item={item} entryId={entryId} />
		<AnimatePresence initial={false}>{(showMetrics || showActions) && !item.active && <Reveal>
			<MessageFooter entryId={showActions ? entryId : undefined}>
				{showMetrics && <ReplyMetrics {...item.metrics} scope="本条" speed={item.speed} />}
			</MessageFooter>
		</Reveal>}</AnimatePresence>
	</div>;
}, (before, after) => before.entryId === after.entryId && before.first === after.first && before.last === after.last
	&& before.showMetrics === after.showMetrics && before.showActions === after.showActions && sameTranscriptItem(before.item, after.item));

export function useAutoFold(key: string, tracking: boolean) {
	const [open, setOpen] = useDisclosureMemory(`${key}:open`, tracking);
	const [folded, setFolded] = useDisclosureMemory(`${key}:folded`, !tracking);
	useEffect(() => {
		if (!tracking && !folded) {
			setFolded(true);
			setOpen(false);
		}
	}, [tracking, folded, setFolded, setOpen]);
	return [open, setOpen] as const;
}

const Activity = memo(function Activity({ id, items, entryIds, tracking, animateInitial }: {
	id: string; items: ActivityItem[]; entryIds: (string | undefined)[]; tracking: boolean; animateInitial: boolean;
}) {
	const [open, setOpen] = useAutoFold(`activity:${id}`, tracking);
	const thoughts = items.filter((item) => item.kind === "thinking").length;
	const tools = items.filter((item) => item.kind === "tool");
	const failures = tools.filter((item) => item.tool.state === "failed").length;
	const skills = skillCount(items);
	const pruned = items.some((item) => item.kind === "tool" && item.pruned);
	const counts = [
		thoughts ? `${thoughts} 段思考` : "",
		skills ? `${skills} 个技能` : "",
		tools.length ? `${tools.length} 次工具调用` : "",
		failures ? `${failures} 次失败` : "",
	].filter(Boolean).join(" · ");
	return <Disclosure className="reply-process reply-activity" open={open} onOpenChange={setOpen} summary={<>
		<ReplyStatusLabel className={`pruned-text${pruned ? " pruned-text-active" : ""}`} active={tracking}>思考与工具</ReplyStatusLabel>
		<span className={`reply-counts pruned-text${pruned ? " pruned-text-active" : ""}`}>{counts}</span>
	</>}><div className="reply-process-content"><AnimatePresence initial={animateInitial}>
		{items.map((item) => <Item key={item.key} item={item} entryId={entryIds[item.messageIndex]} showActions={item.showActions} />)}
	</AnimatePresence></div></Disclosure>;
}, (before, after) => before.id === after.id && before.tracking === after.tracking && before.animateInitial === after.animateInitial && sameContent(before, after));

const Item = memo(function Item({ item, entryId, showActions = false }: { item: TranscriptItem; entryId: string | undefined; showActions?: boolean }) {
	switch (item.kind) {
		case "message": return <Message value={item.message} entryId={entryId} />;
		case "text": return <article data-entry-id={entryId} className="message assistant"><StreamingText text={item.text} active={item.active} reveal /></article>;
		case "thinking": return <Reveal><Thinking id={item.key} text={item.text} active={item.active} entryId={entryId} />{showActions && <MessageFooter entryId={entryId} />}</Reveal>;
		case "tool": return <Reveal data-entry-id={entryId}><ToolActivity tool={item.tool} />{showActions && <MessageFooter entryId={entryId} />}</Reveal>;
		case "error": return <><pre data-entry-id={entryId} className="message error">{item.text}</pre>{showActions && <MessageFooter entryId={entryId} />}</>;
	}
}, (before, after) => before.entryId === after.entryId && before.showActions === after.showActions && sameTranscriptItem(before.item, after.item));

function Thinking({ id, text, active, entryId }: { id: string; text: string; active: boolean; entryId: string | undefined }) {
	const [open, setOpen] = useDisclosureMemory(`${id}:open`, active);
	const [wasActive, setWasActive] = useDisclosureMemory(`${id}:active`, active);
	useEffect(() => { if (wasActive !== active) { setWasActive(active); setOpen(active); } }, [active, wasActive, setWasActive, setOpen]);
	return <Disclosure data-entry-id={entryId} className="thinking activity-thinking" lazy open={open} onOpenChange={setOpen} summary={<>
		<ReplyStatusLabel active={active}>{active ? "思考中" : "思考"}</ReplyStatusLabel>
	</>}>
		<div className="thinking-content message"><StreamingText text={text} active={active} reveal /></div>
	</Disclosure>;
}
