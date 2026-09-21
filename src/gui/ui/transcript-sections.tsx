import { memo, useEffect } from "react";
import { useDisclosureMemory } from "./disclosure-memory.ts";
import { LoaderCircle } from "lucide-react";
import { Disclosure } from "./components/disclosure";
import { StreamingText, Message } from "./content.tsx";
import { MessageIdentity, ReplyMetrics } from "./message-meta.tsx";
import { ToolActivity } from "./tool-activity.tsx";
import { skillCount } from "./skill-summary.tsx";
import type { TranscriptItem } from "./transcript-items.ts";

type TextItem = Extract<TranscriptItem, { kind: "text" }>;
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
		return <div key={section.key} className="reply-body">
			<MessageIdentity name={section.first.identity.model} timestamp={section.first.identity.timestamp} />
			{section.items.map((item) => <Item key={item.key} item={item} entryId={entryIds[item.messageIndex]} />)}
			{showMetrics && !section.first.active && <ReplyMetrics metrics={section.first.metrics} scope="本条" />}
		</div>;
	})}</>;
}

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

function Activity({ id, items, entryIds, tracking }: { id: string; items: TranscriptItem[]; entryIds: (string | undefined)[]; tracking: boolean }) {
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
		{tracking && <LoaderCircle className="animate-spin" aria-hidden="true" />}
		<span className={`pruned-text${pruned ? " pruned-text-active" : ""}`}>{tracking ? "正在处理" : "思考与工具"}</span>
		<span className={`reply-counts pruned-text${pruned ? " pruned-text-active" : ""}`}>{counts}</span>
	</>}><div className="reply-process-content">{items.map((item) => <Item key={item.key} item={item} entryId={entryIds[item.messageIndex]} />)}</div></Disclosure>;
}

const Item = memo(function Item({ item, entryId }: { item: TranscriptItem; entryId: string | undefined }) {
	switch (item.kind) {
		case "message": return <Message value={item.message} entryId={entryId} />;
		case "text": return <article data-entry-id={entryId} className="message assistant"><StreamingText text={item.text} active={item.active} /></article>;
		case "thinking": return <Thinking id={item.key} text={item.text} active={item.active} entryId={entryId} />;
		case "tool": return <div data-entry-id={entryId}><ToolActivity tool={item.tool} /></div>;
		case "error": return <pre data-entry-id={entryId} className="message error">{item.text}</pre>;
	}
}, (before, after) => before.entryId === after.entryId && sameItem(before.item, after.item));

function Thinking({ id, text, active, entryId }: { id: string; text: string; active: boolean; entryId: string | undefined }) {
	const [open, setOpen] = useDisclosureMemory(`${id}:open`, active);
	const [wasActive, setWasActive] = useDisclosureMemory(`${id}:active`, active);
	useEffect(() => { if (wasActive !== active) { setWasActive(active); setOpen(active); } }, [active]);
	return <Disclosure data-entry-id={entryId} className="thinking activity-thinking" lazy open={open} onOpenChange={setOpen} summary={<>
		{active && <LoaderCircle className="animate-spin" aria-hidden="true" />}
		{active ? "思考中" : "思考"}
	</>}>
		<div className="thinking-content message"><StreamingText text={text} active={active} /></div>
	</Disclosure>;
}

export function sameItems(before: TranscriptItem[], after: TranscriptItem[]): boolean {
	return before.length === after.length && before.every((item, index) => sameItem(item, after[index]));
}

function sameItem(before: TranscriptItem, after: TranscriptItem | undefined): boolean {
	if (!after || before.key !== after.key || before.kind !== after.kind) return false;
	switch (before.kind) {
		case "message": return after.kind === "message" && before.message === after.message;
		case "tool": return after.kind === "tool" && before.pruned === after.pruned && before.tool.id === after.tool.id && before.tool.name === after.tool.name
			&& before.tool.state === after.tool.state && before.tool.args === after.tool.args && before.tool.output === after.tool.output;
		case "text": return after.kind === "text" && before.text === after.text && before.active === after.active
			&& JSON.stringify(before.identity) === JSON.stringify(after.identity) && JSON.stringify(before.metrics) === JSON.stringify(after.metrics);
		case "thinking": return after.kind === "thinking" && before.text === after.text && before.active === after.active;
		case "error": return after.kind === "error" && before.text === after.text;
	}
}
