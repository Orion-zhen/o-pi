import { memo, useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { fade } from "../lib/motion";
import { Disclosure } from "../components/disclosure";
import { Message } from "../content/content.tsx";
import { skillCount } from "./skill-summary.tsx";
import { MessageIdentity, ReplyMetrics } from "../content/message-meta.tsx";
import { ReplyItems, useAutoFold } from "./transcript-sections.tsx";
import { ReplyBreathing, replyTiming } from "./reply-breathing.tsx";
import { ReplyStatusLabel } from "./reply-status-label.tsx";
import type { TranscriptSource } from "./transcript-items.ts";
import type { TranscriptReply, TranscriptRow } from "./transcript-replies.ts";
import { useTranscriptRows } from "./use-transcript-rows.ts";
import { NoticeGroupContent, type NoticeGroup } from "../app/notices";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useVirtualRows } from "../lib/use-virtual-rows.ts";
import type { SessionViewState } from "../sessions/session-views.ts";

type Row = TranscriptRow | { kind: "notices"; key: string; group: NoticeGroup };
const noIds: (string | undefined)[] = [];
const noGroups: NoticeGroup[] = [];
const noPrunedToolCallIds: ReadonlySet<string> = new Set();

export const Transcript = memo(function Transcript({ source, entryIds = noIds, groups = noGroups, tail = 0, clear, target, view, windowRef, prunedToolCallIds = noPrunedToolCallIds }: {
	source: TranscriptSource;
	entryIds?: (string | undefined)[];
	groups?: NoticeGroup[];
	tail?: number;
	clear: (ids: string[]) => void;
	target?: string | undefined;
	view?: SessionViewState | undefined;
	windowRef?: RefObject<Virtualizer<HTMLElement, HTMLElement> | null>;
	prunedToolCallIds?: ReadonlySet<string>;
}) {
	const replies = useTranscriptRows(source, prunedToolCallIds);
	const rows = useMemo(() => {
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
	}, [replies, groups]);
	const targetIndex = useMemo(() => {
		if (!target) return -1;
		return rows.findIndex((row) => row.kind === "message" ? entryIds[row.messageIndex] === target
			: row.kind === "reply" && row.messageIndices.some((index) => entryIds[index] === target));
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
	const skills = skillCount(reply.process);
	const counts = [
		thoughts > 0 ? `${thoughts} 段思考` : "",
		skills > 0 ? `${skills} 个技能` : "",
		tools.length > 0 ? `${tools.length} 次工具调用` : "",
		failures > 0 ? `${failures} 次失败` : "",
	].filter(Boolean).join(" · ");
	const running = reply.state === "running";
	const hasAnswer = reply.answer.length > 0;
	const processTail = running && !hasAnswer;
	const pruned = reply.process.some((item) => item.kind === "tool" && item.pruned);
	const showProcess = reply.process.length > 0 || processTail;
	const activityOnly = reply.process.length > 0 && reply.process.every((item) => item.kind === "thinking" || item.kind === "tool");
	const processContent = <div className="reply-turn-content" data-tail={processTail}><ReplyItems items={reply.process} entryIds={entryIds} tracking={reply.tracking} followedByBody={hasAnswer} /></div>;
	const outcome = reply.state === "failed" ? "回复失败" : reply.state === "stopped" ? "已停止" : reply.state === "continued" ? "已接续" : "未收到完整回复";
	return <motion.section {...fade} className="assistant-reply" style={replyTiming} data-state={reply.state} data-entry-ids={reply.messageIndices.map((index) => entryIds[index]).filter(Boolean).join(" ")}>
		{activityOnly ? processContent : <Disclosure className="reply-process" data-tail={processTail} hidden={!showProcess} open={open} onOpenChange={setOpen} summary={<>
				{pruned && <span className="reply-pruned-label">已裁剪</span>}
				<ReplyStatusLabel active={running}>{reply.retrying ? "正在重试" : "本轮过程"}</ReplyStatusLabel>
				{counts && <span className="reply-counts">{counts}</span>}
			</>}>
			{processContent}
		</Disclosure>}
		{reply.identity && !hasAnswer && !running && <MessageIdentity name={reply.identity.model} timestamp={reply.identity.timestamp} />}
		<div className="reply-answer" data-tail={running} hidden={running && !hasAnswer}><ReplyItems items={reply.answer} entryIds={entryIds} showMetrics={false} /></div>
		<AnimatePresence presenceAffectsLayout={false}>{running && <ReplyBreathing key="breathing" />}</AnimatePresence>
		{!running && reply.state !== "completed" && <div className="reply-outcome" role={reply.state === "failed" ? "alert" : "status"}>
			<span>{outcome}</span>
			{reply.error && <pre>{reply.error}</pre>}
		</div>}
		{!running && reply.identity && <ReplyMetrics {...reply.metrics} />}
	</motion.section>;
});
