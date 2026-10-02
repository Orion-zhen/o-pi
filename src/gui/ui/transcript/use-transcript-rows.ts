import { useMemo } from "react";
import { SKILL_CONTEXT_MESSAGE } from "../../../harness/skill-context/types.ts";
import { transcriptReplies } from "./transcript-replies.ts";
import type { TranscriptSource } from "./transcript-items.ts";

/** 流式更新只投影最后一个消息组，历史分组不随每段输出重新构造。 */
export function useTranscriptRows(source: TranscriptSource, pruned: ReadonlySet<string>) {
	const history = useMemo(() => {
		let offset = Math.max(0, source.messages.findLastIndex((message) => message.role === "user" || message.role === "bashExecution"
			|| message.role === "compactionSummary" || message.role === "branchSummary"
			|| message.role === "custom" && message.customType === SKILL_CONTEXT_MESSAGE && message.display));
		const calls = new Map<string, number>();
		const results = new Map<string, number>();
		for (const [index, message] of source.messages.entries()) {
			if (message.role === "assistant") for (const block of message.content) { if (block.type === "toolCall") calls.set(block.id, index); }
			if (message.role === "toolResult") results.set(message.toolCallId, index);
		}
		// 扩展消息或导入记录可能把调用与结果分隔到两组，仍按完整历史关联。
		if ([...results].some(([id, index]) => {
			const call = calls.get(id);
			return call !== undefined && (call < offset) !== (index < offset);
		})) offset = 0;
		// 保留下一组起点，让上一轮仍能判定用户引导造成的接续。
		const rows = offset === 0 ? [] : transcriptReplies({ ...source, messages: source.messages.slice(0, offset + 1),
			streamingMessage: null, liveTools: [], streaming: false, retrying: false }, pruned)
			.filter((row) => row.kind === "message" ? row.messageIndex < offset : row.messageIndices.every((index) => index < offset));
		const tools = new Set([...calls, ...results].filter(([, index]) => index < offset).map(([id]) => id));
		return { rows, offset, messages: source.messages.slice(offset), tools };
	}, [source.messages, source.models, source.messageDurations, pruned]);
	return useMemo(() => {
		// 历史分组中的在途工具仍需接收进度，缺失结果本身不触发全量投影。
		if (source.liveTools.some((event) => history.tools.has(event.toolCallId))) return transcriptReplies(source, pruned);
		return [...history.rows, ...transcriptReplies({ ...source, messages: history.messages }, pruned, history.offset)];
	}, [history, source.streamingMessage, source.liveTools, source.streaming, source.retrying, pruned]);
}
