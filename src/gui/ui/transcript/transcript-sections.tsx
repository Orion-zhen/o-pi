import { memo, useEffect } from "react";
import { useDisclosureMemory } from "../components/disclosure-memory.ts";
import { Disclosure } from "../components/disclosure";
import { StreamingText, Message } from "../content/content.tsx";
import { MessageIdentity, ReplyMetrics } from "../content/message-meta.tsx";
import { ToolActivity } from "../tools/tool-activity.tsx";
import { skillCount } from "./skill-summary.tsx";
import { ReplyStatusLabel } from "./reply-status-label.tsx";
import { sameTranscriptItem, type TranscriptItem } from "./transcript-items.ts";

type TextItem = Extract<TranscriptItem, { kind: "text" }>;
interface SectionContent { items: TranscriptItem[]; entryIds: (string | undefined)[] }

function sameContent(before: SectionContent, after: SectionContent): boolean {
	return before.items.length === after.items.length && before.items.every((item, index) => {
		const next = after.items[index];
		return next !== undefined && sameTranscriptItem(item, next)
			&& before.entryIds[item.messageIndex] === after.entryIds[next.messageIndex];
	});
}
type Section = { key: string } & (
	| { kind: "body"; items: TextItem[]; first: TextItem }
	| { kind: "activity"; items: TranscriptItem[] }
	| { kind: "item"; item: TranscriptItem }
);

export function ReplyItems({ items, entryIds, tracking = false, followedByBody = false, showMetrics = true }: {
	items: TranscriptItem[]; entryIds: (string | undefined)[]; tracking?: boolean; followedByBody?: boolean; showMetrics?: boolean;
}) {
	const sections: Section[] = [];
	for (const item of items) {
		const previous = sections.at(-1);
		if (item.kind === "text") {
			if (previous?.kind === "body" && previous.first.messageIndex === item.messageIndex) previous.items.push(item);
			else sections.push({ key: item.key, kind: "body", items: [item], first: item });
		} else if (item.kind === "thinking" || item.kind === "tool") {
			if (previous?.kind === "activity") previous.items.push(item);
			else sections.push({ key: item.key, kind: "activity", items: [item] });
		} else sections.push({ key: item.key, kind: "item", item });
	}
	return <>{sections.map((section, index) => {
		if (section.kind === "item") return <Item key={section.key} item={section.item} entryId={entryIds[section.item.messageIndex]} />;
		if (section.kind === "activity") return <Activity key={section.key} id={section.key} items={section.items} entryIds={entryIds}
			tracking={tracking && !followedByBody && !sections.slice(index + 1).some((next) => next.kind === "body")} />;
		return <Body key={section.key} first={section.first} items={section.items} entryIds={entryIds} showMetrics={showMetrics} />;
	})}</>;
}

const Body = memo(function Body({ first, items, entryIds, showMetrics }: {
	first: TextItem; items: TextItem[]; entryIds: (string | undefined)[]; showMetrics: boolean;
}) {
	return <div className="reply-body">
		<MessageIdentity name={first.identity.model} timestamp={first.identity.timestamp} />
		{items.map((item) => <Item key={item.key} item={item} entryId={entryIds[item.messageIndex]} />)}
		{showMetrics && !first.active && <ReplyMetrics {...first.metrics} scope="本条" />}
	</div>;
}, (before, after) => before.showMetrics === after.showMetrics && sameTranscriptItem(before.first, after.first) && sameContent(before, after));

export function useAutoFold(key: string, tracking: boolean) {
	const [open, setOpen] = useDisclosureMemory(`${key}:open`, tracking);
	const [folded, setFolded] = useDisclosureMemory(`${key}:folded`, !tracking);
	useEffect(() => {
		if (!tracking && !folded) {
			setFolded(true);
			setOpen(false);
		}
	}, [tracking]);
	return [open, setOpen] as const;
}

const Activity = memo(function Activity({ id, items, entryIds, tracking }: SectionContent & { id: string; tracking: boolean }) {
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
	</>}><div className="reply-process-content">{items.map((item) => <Item key={item.key} item={item} entryId={entryIds[item.messageIndex]} />)}</div></Disclosure>;
}, (before, after) => before.id === after.id && before.tracking === after.tracking && sameContent(before, after));

const Item = memo(function Item({ item, entryId }: { item: TranscriptItem; entryId: string | undefined }) {
	switch (item.kind) {
		case "message": return <Message value={item.message} entryId={entryId} />;
		case "text": return <article data-entry-id={entryId} className="message assistant"><StreamingText text={item.text} active={item.active} /></article>;
		case "thinking": return <Thinking id={item.key} text={item.text} active={item.active} entryId={entryId} />;
		case "tool": return <div data-entry-id={entryId}><ToolActivity tool={item.tool} /></div>;
		case "error": return <pre data-entry-id={entryId} className="message error">{item.text}</pre>;
	}
}, (before, after) => before.entryId === after.entryId && sameTranscriptItem(before.item, after.item));

function Thinking({ id, text, active, entryId }: { id: string; text: string; active: boolean; entryId: string | undefined }) {
	const [open, setOpen] = useDisclosureMemory(`${id}:open`, active);
	const [wasActive, setWasActive] = useDisclosureMemory(`${id}:active`, active);
	useEffect(() => { if (wasActive !== active) { setWasActive(active); setOpen(active); } }, [active]);
	return <Disclosure data-entry-id={entryId} className="thinking activity-thinking" lazy open={open} onOpenChange={setOpen} summary={<>
		<ReplyStatusLabel active={active}>{active ? "思考中" : "思考"}</ReplyStatusLabel>
	</>}>
		<div className="thinking-content message"><StreamingText text={text} active={active} /></div>
	</Disclosure>;
}
