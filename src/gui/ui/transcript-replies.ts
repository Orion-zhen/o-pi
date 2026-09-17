import { replyMetrics } from "../message-metrics.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { transcriptItems, type TranscriptItem, type TranscriptSource } from "./transcript-items.ts";

export type ReplyState = "running" | "completed" | "continued" | "stopped" | "failed" | "incomplete";
export interface TranscriptReply {
	kind: "reply";
	key: string;
	messageIndices: number[];
	identity: { model: string; timestamp: number } | undefined;
	metrics: ReturnType<typeof replyMetrics>;
	state: ReplyState;
	retrying: boolean;
	final: boolean;
	tracking: boolean;
	process: TranscriptItem[];
	answer: Extract<TranscriptItem, { kind: "text" }>[];
	error: string | undefined;
}
export type TranscriptRow = Extract<TranscriptItem, { kind: "message" }> | TranscriptReply;
interface ReplyDraft {
	kind: "reply";
	key: string;
	items: TranscriptItem[];
	messageIndices: number[];
	assistants: AssistantMessage[];
	followedByUser: boolean;
	lastAssistant: { message: AssistantMessage; index: number } | undefined;
}

/** 每条用户消息开启一组。用户 Shell 和上下文摘要保持独立，不藏进模型过程。 */
export function transcriptReplies(source: TranscriptSource): TranscriptRow[] {
	const messages = source.streamingMessage ? [...source.messages, source.streamingMessage] : source.messages;
	const byMessage = new Map<number, TranscriptItem[]>();
	for (const item of transcriptItems(source)) {
		const items = byMessage.get(item.messageIndex);
		if (items) items.push(item);
		else byMessage.set(item.messageIndex, [item]);
	}
	const rows: (Extract<TranscriptItem, { kind: "message" }> | ReplyDraft)[] = [];
	let current: ReplyDraft | undefined;
	const begin = (key: string) => {
		current = { kind: "reply", key: `reply:${key}`, items: [], messageIndices: [], assistants: [], followedByUser: false, lastAssistant: undefined };
		rows.push(current);
		return current;
	};
	messages.forEach((message, index) => {
		const items = byMessage.get(index) ?? [];
		if (message.role === "user" || message.role === "bashExecution" || message.role === "compactionSummary" || message.role === "branchSummary") {
			if (current && message.role === "user") current.followedByUser = true;
			for (const item of items) if (item.kind === "message") rows.push(item);
			current = undefined;
			if (message.role === "user") begin(`user:${index}:${message.timestamp}`);
			return;
		}
		if (!current && message.role === "custom") {
			for (const item of items) if (item.kind === "message") rows.push(item);
			return;
		}
		const reply = current ?? begin(`history:${index}:${message.timestamp}`);
		reply.items.push(...items);
		reply.messageIndices.push(index);
		if (message.role === "assistant") {
			reply.lastAssistant = { message, index };
			reply.assistants.push(message);
		}
	});
	const live = byMessage.get(messages.length);
	if (live) (current ?? begin("live")).items.push(...live);

	return rows.flatMap((row): TranscriptRow[] => {
		if (row.kind === "message") return [row];
		const active = row === current && (source.streaming || source.retrying);
		if (!row.items.length && !row.lastAssistant && !active) return [];
		return [finishReply(row, source, active)];
	});
}

function finishReply(draft: ReplyDraft, source: TranscriptSource, active: boolean): TranscriptReply {
	const last = draft.lastAssistant;
	const message = last?.message;
	const retrying = active && source.retrying;
	const streamingMessage = message === source.streamingMessage;
	const selection = message && !retrying ? answerBlocks(message) : { indices: new Set<number>(), explicit: false };
	const answer = draft.items.filter((item): item is Extract<TranscriptItem, { kind: "text" }> =>
		item.kind === "text" && item.messageIndex === last?.index && selection.indices.has(item.blockIndex));
	const answerKeys = new Set(answer.map((item) => item.key));
	const error = !active ? message?.errorMessage : undefined;
	const process = draft.items.filter((item) => !answerKeys.has(item.key)
		&& !(error && item.kind === "error" && item.messageIndex === last?.index));
	// 接续只描述消息间的关系，不把截断、缺失结果或中止的工具阶段当成正常结束。
	const continued = draft.followedByUser && !error
		&& (message?.stopReason === "stop" || message?.stopReason === "toolUse" || message?.stopReason === "deferred")
		&& message.content.length > 0
		&& process.every((item) => item.kind !== "tool" || item.messageIndex !== last?.index
			|| item.tool.state === "completed" || item.tool.state === "failed");
	const state: ReplyState = active ? "running"
		: message?.stopReason === "aborted" ? "stopped"
		: message?.stopReason === "error" ? "failed"
		: message?.stopReason === "stop" && answer.length > 0 ? "completed"
		: continued ? "continued" : "incomplete";
	const final = answer.length > 0 && (selection.explicit || (message?.stopReason === "stop" && !streamingMessage));
	const model = message && source.models.find((model) => model.provider === message.provider && model.id === message.model);
	const identity = message ? { model: model?.name ?? message.model, timestamp: message.timestamp } : undefined;
	const metrics = replyMetrics(draft.assistants, source.messageDurations);
	return { kind: "reply", identity, metrics, key: draft.key, messageIndices: draft.messageIndices, state, retrying, final, tracking: active && !final, process, answer, error };
}

function answerBlocks(message: AssistantMessage): { indices: Set<number>; explicit: boolean } {
	if (message.content.some((block) => block.type === "toolCall") || message.stopReason === "toolUse" || message.stopReason === "deferred")
		return { indices: new Set(), explicit: false };
	const phases = message.content.map((block) => block.type === "text" ? textPhase(block.textSignature) : undefined);
	const explicit = phases.flatMap((phase, index) => phase === "final_answer" ? [index] : []);
	if (explicit.length) return { indices: new Set(explicit), explicit: true };

	// 没有阶段标记时，保留最后一条模型消息尾部的正文。后续出现工具或新消息时自动归回过程。
	const indices = new Set<number>();
	for (let index = message.content.length - 1; index >= 0; index--) {
		const block = message.content[index];
		if (block?.type !== "text" || phases[index] === "commentary") break;
		indices.add(index);
	}
	return { indices, explicit: false };
}

function textPhase(signature: string | undefined): "commentary" | "final_answer" | undefined {
	// SDK 的旧会话使用普通字符串签名，Responses 新会话使用 TextSignatureV1。
	if (!signature?.startsWith("{")) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(signature);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1
		|| !("id" in value) || typeof value.id !== "string" || !("phase" in value)) return undefined;
	return value.phase === "commentary" || value.phase === "final_answer" ? value.phase : undefined;
}
