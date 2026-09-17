import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GuiSnapshot } from "../contract.ts";

export type TranscriptSource = Pick<GuiSnapshot, "messages" | "models" | "messageDurations" | "streamingMessage" | "liveTools" | "streaming" | "retrying">;
export type ToolState = "preparing" | "pending" | "running" | "completed" | "failed" | "stopped" | "unavailable";
export interface ToolOutput {
	content: unknown;
	details?: unknown;
}
export interface ToolActivity {
	id: string;
	name: string;
	args: unknown;
	state: ToolState;
	output: ToolOutput | undefined;
}
export type TranscriptItem = { key: string; messageIndex: number } & (
	| { kind: "message"; message: AgentMessage }
	| { kind: "text"; text: string; blockIndex: number }
	| { kind: "thinking"; text: string; active: boolean }
	| { kind: "tool"; tool: ToolActivity }
	| { kind: "error"; text: string }
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只投影展示顺序。调用、流式结果和持久结果共用一个稳定节点。 */
export function transcriptItems(source: TranscriptSource): TranscriptItem[] {
	const messages = source.streamingMessage ? [...source.messages, source.streamingMessage] : source.messages;
	const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
	const results = new Map(messages.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
	const live = new Map(source.liveTools.map((event) => [event.toolCallId, event]));
	const calls = new Set(messages.flatMap((message) => message.role === "assistant"
		? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : []));
	const items: TranscriptItem[] = [];

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
		if (message.role === "toolResult") {
			// 压缩或导入的历史可能只保留结果，仍允许查看。
			if (!calls.has(message.toolCallId)) items.push(activity(message.toolCallId, message.toolName, undefined, "unavailable", index));
		} else if (message.role === "assistant") {
			const streaming = message === source.streamingMessage;
			message.content.forEach((block, blockIndex) => {
				const blockKey = `${key}:${blockIndex}`;
				if (block.type === "toolCall") {
					const idle = message.stopReason === "aborted" ? "stopped"
						: streaming ? "preparing"
						: source.streaming && index === lastAssistant ? "pending" : "unavailable";
					items.push(activity(block.id, block.name, block.arguments, idle, index));
				} else if (block.type === "thinking") {
					if (block.thinking && !block.redacted) items.push({
						key: blockKey, messageIndex: index, kind: "thinking", text: block.thinking,
						active: streaming && blockIndex === message.content.length - 1,
					});
				} else if (block.text) items.push({ key: blockKey, messageIndex: index, blockIndex, kind: "text", text: block.text });
			});
			if (message.errorMessage) items.push({ key: `${key}:error`, messageIndex: index, kind: "error", text: message.errorMessage });
		} else if (message.role !== "custom" || message.display !== false) items.push({ key, messageIndex: index, kind: "message", message });
	});
	for (const event of source.liveTools) {
		if (!calls.has(event.toolCallId) && !results.has(event.toolCallId))
			items.push(activity(event.toolCallId, event.toolName, event.args, "running", messages.length));
	}
	return items;
}
