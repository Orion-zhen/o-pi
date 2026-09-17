import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { fade } from "./lib/motion";
import { Disclosure } from "./components/disclosure";
import { Content, MarkdownText, Message } from "./content.tsx";
import { MessageIdentity, ReplyMetrics } from "./message-meta.tsx";
import { ToolActivity } from "./tool-activity.tsx";
import type { TranscriptItem, TranscriptSource } from "./transcript-items.ts";
import { transcriptReplies, type TranscriptReply } from "./transcript-replies.ts";

export function Transcript({ source, entryIds = [] }: { source: TranscriptSource; entryIds?: (string | undefined)[] }) {
	return <AnimatePresence initial={false}>{transcriptReplies(source).map((row) => row.kind === "message"
		? <Message key={row.key} value={row.message} entryId={entryIds[row.messageIndex]} />
		: <Reply key={row.key} reply={row} entryIds={entryIds} />)}</AnimatePresence>;
}

function Reply({ reply, entryIds }: { reply: TranscriptReply; entryIds: (string | undefined)[] }) {
	const [open, setOpen] = useState(reply.tracking);
	const folded = useRef(!reply.tracking);
	useEffect(() => {
		if (!reply.tracking && !folded.current) {
			folded.current = true;
			setOpen(false);
		}
	}, [reply.tracking]);
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
	const outcome = reply.state === "failed" ? "回复失败" : reply.state === "stopped" ? "已停止" : reply.state === "continued" ? "已接续" : "未收到完整回复";
	return <motion.section {...fade} className="assistant-reply" data-state={reply.state} data-entry-ids={reply.messageIndices.map((index) => entryIds[index]).filter(Boolean).join(" ")}>
		<Disclosure className="reply-process" hidden={!showProcess} open={open} onOpenChange={setOpen} summary={<>
				{running && <LoaderCircle className="animate-spin" aria-hidden="true" />}
				<span>{reply.retrying ? "正在重试" : running ? "正在处理" : "处理过程"}</span>
				{counts && <span className="reply-counts">{counts}</span>}
			</>}>
			<div className="reply-process-content"><Items items={reply.process} entryIds={entryIds} /></div>
		</Disclosure>
		{reply.identity && (reply.answer.length > 0 || !running) && <MessageIdentity name={reply.identity.model} timestamp={reply.identity.timestamp} />}
		<div className="reply-answer"><Items items={reply.answer} entryIds={entryIds} /></div>
		{!running && reply.state !== "completed" && <div className="reply-outcome" role={reply.state === "failed" ? "alert" : "status"}>
			<span>{outcome}</span>
			{reply.error && <pre>{reply.error}</pre>}
		</div>}
		{!running && reply.identity && <ReplyMetrics metrics={reply.metrics} />}
	</motion.section>;
}

function Items({ items, entryIds }: { items: TranscriptItem[]; entryIds: (string | undefined)[] }) {
	return <>{items.map((item) => <Item key={item.key} item={item} entryId={entryIds[item.messageIndex]} />)}</>;
}

function Item({ item, entryId }: { item: TranscriptItem; entryId: string | undefined }) {
		switch (item.kind) {
			case "message": return <Message value={item.message} entryId={entryId} />;
			case "text": return <article data-entry-id={entryId} className="message assistant"><MarkdownText text={item.text} /></article>;
			case "thinking": return <Disclosure data-entry-id={entryId} className="thinking activity-thinking" summary={<>
					{item.active && <LoaderCircle className="animate-spin" aria-hidden="true" />}
					{item.active ? "思考中" : "思考"}
				</>}>
				<div className="thinking-content message"><Content value={item.text} /></div>
			</Disclosure>;
			case "tool": return <div data-entry-id={entryId}><ToolActivity tool={item.tool} /></div>;
			case "error": return <pre data-entry-id={entryId} className="message error">{item.text}</pre>;
		}
}
