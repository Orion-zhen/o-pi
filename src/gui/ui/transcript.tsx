import { memo } from "react";
import { LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { fade } from "./lib/motion";
import { Disclosure } from "./components/disclosure";
import { Message } from "./content.tsx";
import { MessageIdentity, ReplyMetrics } from "./message-meta.tsx";
import { ReplyItems, sameItems, useAutoFold } from "./transcript-sections.tsx";
import type { TranscriptSource } from "./transcript-items.ts";
import { transcriptReplies, type TranscriptReply, type TranscriptRow } from "./transcript-replies.ts";
import { NoticeGroupView, type NoticeGroup } from "./notices";

export function Transcript({ source, entryIds = [], groups = [], tail = 0, clear }: {
	source: TranscriptSource;
	entryIds?: (string | undefined)[];
	groups?: NoticeGroup[];
	tail?: number;
	clear: (ids: string[]) => void;
}) {
	const rows = transcriptReplies(source);
	const children = rows.map((row) => row.kind === "message"
		? <Message key={row.key} value={row.message} entryId={entryIds[row.messageIndex]} />
		: <Reply key={row.key} reply={row} entryIds={entryIds} />);
	let inserted = 0;
	for (const group of groups) {
		let index = 0;
		for (const [i, row] of rows.entries()) {
			if (rowLastIndex(row) <= group.anchor - 1) index = i + 1;
			else break;
		}
		children.splice(index + inserted, 0,
			<NoticeGroupView key={`notices:${group.anchor}`} group={group} live={group.anchor >= tail} clear={clear} />);
		inserted++;
	}
	return <AnimatePresence initial={false}>{children}</AnimatePresence>;
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
