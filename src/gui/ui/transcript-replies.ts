import { replyMetrics } from "../message-metrics.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TranscriptItem, TranscriptSource, ToolState } from "./transcript-items.ts";

export type ReplyState = "running" | "completed" | "continued" | "stopped" | "failed" | "incomplete";
export interface TranscriptReply {
	kind: "reply";
	key: string;
	messageIndices: number[];
	identity: { model: string; timestamp: number } | undefined;
	metrics: ReturnType<typeof replyMetrics>;
	state: ReplyState;
	retrying: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 每条用户消息开启一组，直接按消息顺序投影。工具结果按调用 ID 关联。 */
export function transcriptReplies(source: TranscriptSource): TranscriptRow[] {
	const messages = source.streamingMessage ? [...source.messages, source.streamingMessage] : source.messages;
	const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
	const results = new Map(messages.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
	const live = new Map(source.liveTools.map((event) => [event.toolCallId, event]));
	const calls = new Set(messages.flatMap((message) => message.role === "assistant"
		? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : []));
	const rows: (Extract<TranscriptItem, { kind: "message" }> | ReplyDraft)[] = [];
	let current: ReplyDraft | undefined;
	const begin = (key: string) => {
		current = { kind: "reply", key: `reply:${key}`, items: [], messageIndices: [], assistants: [], followedByUser: false, lastAssistant: undefined };
		rows.push(current);
		return current;
	};
	function activity(id: string, name: string, args: unknown, idle: ToolState, messageIndex: number): TranscriptItem {
		const result = results.get(id);
		const event = live.get(id);
		const partial: unknown = event?.type === "tool_execution_update" ? event.partialResult : undefined;
		const details: unknown = result?.details;
		const state = result
			? isRecord(details) && details.status === "aborted" ? "stopped" : result.isError ? "failed" : "completed"
			: event ? "running" : idle;
		return {
			key: `tool:${id}`, kind: "tool", messageIndex,
			tool: {
				id, name, args, state,
				output: result ?? (isRecord(partial) ? { content: partial.content, details: partial.details } : undefined),
			},
		};
	}
	messages.forEach((message, index) => {
		const key = `message:${index}:${message.timestamp}`;
		const standalone: TranscriptRow = { key, kind: "message", messageIndex: index, message };
		if (message.role === "user" || message.role === "bashExecution" || message.role === "compactionSummary" || message.role === "branchSummary") {
			if (current && message.role === "user") current.followedByUser = true;
			rows.push(standalone);
			current = undefined;
			if (message.role === "user") begin(`user:${index}:${message.timestamp}`);
			return;
		}
		if (!current && message.role === "custom") {
			if (message.display !== false) rows.push(standalone);
			return;
		}
		const reply = current ?? begin(`history:${index}:${message.timestamp}`);
		reply.messageIndices.push(index);
		if (message.role === "toolResult") {
			// 压缩或导入的历史可能只保留结果，仍允许查看。
			if (!calls.has(message.toolCallId)) reply.items.push(activity(message.toolCallId, message.toolName, undefined, "unavailable", index));
		} else if (message.role === "assistant") {
			reply.lastAssistant = { message, index };
			reply.assistants.push(message);
			const streaming = message === source.streamingMessage;
			const model = source.models.find((model) => model.provider === message.provider && model.id === message.model);
			const identity = { model: model?.name ?? message.model, timestamp: message.timestamp };
			const metrics = replyMetrics([message], source.messageDurations);
			message.content.forEach((block, blockIndex) => {
				const blockKey = `${key}:${blockIndex}`;
				if (block.type === "toolCall") {
					const idle = message.stopReason === "aborted" ? "stopped" : streaming ? "preparing"
						: source.streaming && index === lastAssistant ? "pending" : "unavailable";
					reply.items.push(activity(block.id, block.name, block.arguments, idle, index));
				} else if (block.type === "thinking") {
					if (block.thinking && !block.redacted) reply.items.push({
						key: blockKey, messageIndex: index, kind: "thinking", text: block.thinking,
						active: streaming && blockIndex === message.content.length - 1,
					});
				} else if (block.text.trim()) reply.items.push({ key: blockKey, messageIndex: index, blockIndex, kind: "text", text: block.text, active: streaming, identity, metrics });
			});
			if (message.errorMessage) reply.items.push({ key: `${key}:error`, messageIndex: index, kind: "error", text: message.errorMessage });
		} else if (message.role !== "custom" || message.display !== false) reply.items.push(standalone);
	});
	for (const event of source.liveTools) {
		if (!calls.has(event.toolCallId) && !results.has(event.toolCallId))
			(current ?? begin("live")).items.push(activity(event.toolCallId, event.toolName, event.args, "running", messages.length));
	}
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
	const selection = message && !retrying ? answerBlocks(message) : new Set<number>();
	const answer = draft.items.filter((item): item is Extract<TranscriptItem, { kind: "text" }> =>
		item.kind === "text" && item.messageIndex === last?.index && selection.has(item.blockIndex));
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
	const model = message && source.models.find((model) => model.provider === message.provider && model.id === message.model);
	const identity = message ? { model: model?.name ?? message.model, timestamp: message.timestamp } : undefined;
	const metrics = replyMetrics(draft.assistants, source.messageDurations);
	return { kind: "reply", identity, metrics, key: draft.key, messageIndices: draft.messageIndices, state, retrying, tracking: active, process, answer, error };
}

function answerBlocks(message: AssistantMessage): Set<number> {
	if (message.content.some((block) => block.type === "toolCall") || message.stopReason === "toolUse" || message.stopReason === "deferred")
		return new Set();
	const phases = message.content.map((block) => block.type === "text" ? textPhase(block.textSignature) : undefined);
	const explicit = phases.flatMap((phase, index) => phase === "final_answer" ? [index] : []);
	if (explicit.length) return new Set(explicit);

	// 没有阶段标记时，保留最后一条模型消息尾部的正文。后续出现工具或新消息时自动归回过程。
	const indices = new Set<number>();
	for (let index = message.content.length - 1; index >= 0; index--) {
		const block = message.content[index];
		if (block?.type !== "text" || phases[index] === "commentary") break;
		indices.add(index);
	}
	return indices;
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
