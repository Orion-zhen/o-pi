import { memo, useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { fade } from "./lib/motion";
import { Disclosure } from "./components/disclosure";
import { Message } from "./content.tsx";
import { MessageIdentity, ReplyMetrics } from "./message-meta.tsx";
import { ReplyItems, sameItems, useAutoFold } from "./transcript-sections.tsx";
import type { TranscriptSource } from "./transcript-items.ts";
import { transcriptReplies, type TranscriptReply, type TranscriptRow } from "./transcript-replies.ts";
import { NoticeGroupContent, type NoticeGroup } from "./notices";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useVirtualRows } from "./use-virtual-rows.ts";
import type { SessionViewState } from "./session-views.ts";

type Row = TranscriptRow | { kind: "notices"; key: string; group: NoticeGroup };
const noIds: (string | undefined)[] = [];
const noGroups: NoticeGroup[] = [];

export const Transcript = memo(function Transcript({ source, entryIds = noIds, groups = noGroups, tail = 0, clear, target, view, windowRef }: {
	source: TranscriptSource;
	entryIds?: (string | undefined)[];
	groups?: NoticeGroup[];
	tail?: number;
	clear: (ids: string[]) => void;
	target?: string | undefined;
	view?: SessionViewState | undefined;
	windowRef?: RefObject<Virtualizer<HTMLElement, HTMLElement> | null>;
}) {
	const rows = useMemo(() => {
		const replies = transcriptReplies(source);
		const rows: Row[] = [...replies];
		let inserted = 0;
		for (const group of groups) {
			let index = 0;
			for (const [i, row] of replies.entries()) {
				if (rowLastIndex(row) < group.anchor) index = i + 1;
				else break;
			}
			rows.splice(index + inserted++, 0, { kind: "notices", key: `notices:${group.anchor}`, group });
		}
		return rows;
	}, [source, groups]);
	const targetIndex = useMemo(() => {
		if (!target) return -1;
		const index = entryIds.indexOf(target);
		return index < 0 ? -1 : rows.findIndex((row) => row.kind === "message" ? row.messageIndex === index
			: row.kind === "reply" && row.messageIndices.includes(index));
	}, [rows, entryIds, target]);
	const getKey = useCallback((index: number) => (rows[index] as Row).key, [rows]);
	const list = useVirtualRows<HTMLDivElement>(rows.length, getKey, 220, {
		top: view?.position?.top ?? 0, measurements: view?.measurements ?? [], targetIndex,
	});
	const initialCount = useRef(rows.length);
	useLayoutEffect(() => {
		if (windowRef) windowRef.current = list.windowed ? list.virtualizer : null;
		return () => { if (windowRef) windowRef.current = null; };
	}, [windowRef, list.virtualizer, list.windowed]);
	useLayoutEffect(() => () => { if (view && list.windowed) view.measurements = list.virtualizer.takeSnapshot(); }, [view, list.virtualizer, list.windowed]);
	return <div ref={list.root} style={list.style} className="transcript-rows">
		<AnimatePresence initial={false} presenceAffectsLayout={false}>{list.rows.map(({ index, key, start }) => {
			const row = rows[index] as Row;
			return <motion.div {...fade} initial={index < initialCount.current ? false : fade.initial} key={key} className="transcript-row"
				data-index={index} data-first={index === 0} ref={list.windowed ? list.virtualizer.measureElement : undefined} style={{ ...list.rowStyle(start) }}>
				<AnimatePresence initial={false} presenceAffectsLayout={false}>
					{row.kind === "message" ? <Message key={row.key} value={row.message} entryId={entryIds[row.messageIndex]} />
						: row.kind === "reply" ? <Reply key={row.key} reply={row} entryIds={entryIds} />
						: <InlineNotices key={row.group.notices.at(-1)?.id} group={row.group} live={row.group.anchor >= tail} clear={clear} />}
				</AnimatePresence>
			</motion.div>;
		})}</AnimatePresence>
	</div>;
});

function InlineNotices({ group, live, clear }: { group: NoticeGroup; live: boolean; clear: (ids: string[]) => void }) {
	const [open, setOpen] = useAutoFold(`notices:${group.notices.at(-1)?.id}`, live);
	return <NoticeGroupContent group={group} clear={clear} open={open} onOpenChange={setOpen} />;
}

function rowLastIndex(row: TranscriptRow): number {
	return row.kind === "message" ? row.messageIndex : row.messageIndices[row.messageIndices.length - 1] ?? -1;
}

const Reply = memo(function Reply({ reply, entryIds }: { reply: TranscriptReply; entryIds: (string | undefined)[] }) {
	const [open, setOpen] = useAutoFold(reply.key, reply.tracking);
	const tools = reply.process.filter((item) => item.kind === "tool");
	const thoughts = reply.process.filter((item) => item.kind === "thinking").length;
	const failures = tools.filter((item) => item.tool.state === "failed").length;
	const counts = [
		thoughts > 0 ? `${thoughts} 段思考` : "",
		tools.length > 0 ? `${tools.length} 次工具调用` : "",
		failures > 0 ? `${failures} 次失败` : "",
	].filter(Boolean).join(" · ");
	const running = reply.state === "running";
	const showProcess = reply.process.length > 0 || (running && reply.answer.length === 0);
	const activityOnly = reply.process.length > 0 && reply.process.every((item) => item.kind === "thinking" || item.kind === "tool");
	const processContent = <div className="reply-turn-content"><ReplyItems items={reply.process} entryIds={entryIds} tracking={reply.tracking} followedByBody={reply.answer.length > 0} /></div>;
	const outcome = reply.state === "failed" ? "回复失败" : reply.state === "stopped" ? "已停止" : reply.state === "continued" ? "已接续" : "未收到完整回复";
	return <motion.section {...fade} className="assistant-reply" data-state={reply.state} data-entry-ids={reply.messageIndices.map((index) => entryIds[index]).filter(Boolean).join(" ")}>
		{activityOnly ? processContent : <Disclosure className="reply-process" hidden={!showProcess} open={open} onOpenChange={setOpen} summary={<>
				{running && <LoaderCircle className="animate-spin" aria-hidden="true" />}
				<span>{reply.retrying ? "正在重试" : running ? "正在处理" : "本轮过程"}</span>
				{counts && <span className="reply-counts">{counts}</span>}
			</>}>
			{processContent}
		</Disclosure>}
		{reply.identity && reply.answer.length === 0 && !running && <MessageIdentity name={reply.identity.model} timestamp={reply.identity.timestamp} />}
		<div className="reply-answer"><ReplyItems items={reply.answer} entryIds={entryIds} showMetrics={false} /></div>
		{!running && reply.state !== "completed" && <div className="reply-outcome" role={reply.state === "failed" ? "alert" : "status"}>
			<span>{outcome}</span>
			{reply.error && <pre>{reply.error}</pre>}
		</div>}
		{!running && reply.identity && <ReplyMetrics metrics={reply.metrics} />}
	</motion.section>;
}, (before, after) => before.reply.state === after.reply.state && before.reply.tracking === after.reply.tracking
	&& before.reply.retrying === after.reply.retrying && before.reply.error === after.reply.error
	&& JSON.stringify(before.reply.identity) === JSON.stringify(after.reply.identity)
	&& JSON.stringify(before.reply.metrics) === JSON.stringify(after.reply.metrics)
	&& sameItems(before.reply.process, after.reply.process) && sameItems(before.reply.answer, after.reply.answer)
	&& before.reply.messageIndices.length === after.reply.messageIndices.length
	&& before.reply.messageIndices.every((index, i) => index === after.reply.messageIndices[i] && before.entryIds[index] === after.entryIds[index]));
