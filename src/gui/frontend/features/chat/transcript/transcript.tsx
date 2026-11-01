import { memo, useMemo, useRef } from "react";
import { AnimatePresence } from "motion/react";
import { fade } from "@/ui/motion/transitions.ts";
import { Fade, Reveal } from "@/ui/motion/animated.tsx";
import { Message } from "../messages/message.tsx";
import { MessageIdentity, ReplyMetrics } from "../messages/message-meta.tsx";
import { MessageFooter } from "../messages/message-footer.tsx";
import { ReplyContent, useAutoFold } from "./transcript-sections.tsx";
import { ReplyBreathing, replyTiming } from "./reply-breathing.tsx";
import type { TranscriptSource } from "./transcript-items.ts";
import type { TranscriptReply, TranscriptRow } from "./transcript-replies.ts";
import { useTranscriptRows } from "./use-transcript-rows.ts";
import { NoticeGroupContent, type NoticeGroup } from "../messages/notices.tsx";

type Row = TranscriptRow | { kind: "notices"; key: string; group: NoticeGroup };
export const Transcript = memo(function Transcript({ source, entryIds, groups, tail, clear, prunedToolCallIds }: {
	source: TranscriptSource;
	entryIds: (string | undefined)[];
	groups: NoticeGroup[];
	tail: number;
	clear: (ids: string[]) => void;
	prunedToolCallIds: ReadonlySet<string>;
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
	const initialCount = useRef(rows.length);
	return <div className="transcript-rows">
		<AnimatePresence initial={false} presenceAffectsLayout={false}>{rows.map((row, index) =>
			<Fade initial={index < initialCount.current ? false : fade.initial} key={row.key} className="transcript-row" data-first={index === 0}>
				<AnimatePresence initial={false} presenceAffectsLayout={false}>
					{row.kind === "message" ? <Message key={row.key} value={row.message} entryId={entryIds[row.messageIndex]} />
						: row.kind === "reply" ? <Reply key={row.key} reply={row} entryIds={entryIds} />
						: <InlineNotices key={row.group.notices.at(-1)?.id} group={row.group} live={row.group.anchor >= tail} clear={clear} />}
				</AnimatePresence>
			</Fade>
		)}</AnimatePresence>
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
	const running = reply.state === "running";
	const hasAnswer = reply.answer.length > 0;
	const lastAnswer = reply.answer.at(-1);
	const outcome = reply.state === "failed" ? "回复失败" : reply.state === "stopped" ? "已停止" : reply.state === "continued" ? "已接续" : "未收到完整回复";
	return <section className="assistant-reply" style={replyTiming} data-state={reply.state} data-entry-ids={reply.messageIndices.map((index) => entryIds[index]).filter(Boolean).join(" ")}>
		<ReplyContent reply={reply} entryIds={entryIds} />
		<AnimatePresence initial={false}>
			{running ? <ReplyBreathing key="breathing" compacting={reply.compacting} />
				: <Reveal key="result">
					{reply.lastAssistant && !hasAnswer && <MessageIdentity name={reply.lastAssistant.model} timestamp={reply.lastAssistant.timestamp} />}
					{reply.state !== "completed" && <div className="reply-outcome" role={reply.state === "failed" ? "alert" : "status"}>
						<span>{outcome}</span>
						{reply.error && <pre>{reply.error}</pre>}
					</div>}
					{reply.lastAssistant && <MessageFooter entryId={entryIds[reply.lastAssistant.index]}>
						<ReplyMetrics {...reply.metrics} speed={lastAnswer?.speed ?? null} />
					</MessageFooter>}
				</Reveal>}
		</AnimatePresence>
	</section>;
});
