import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { GuiEvent, GuiSnapshot } from "./contract.ts";

type Block = AssistantMessage["content"][number];
type BlockPatch = { index: number; value: Block } | { index: number; field: "text" | "thinking"; delta: string };
type StreamingPatch = { kind: "replace"; value: GuiSnapshot["streamingMessage"] } | {
	kind: "content";
	blocks: BlockPatch[];
	length: number;
	metadata?: Omit<AssistantMessage, "content">;
};
interface Tail<T> { keep: number; items: T[] }
export interface GuiPatch {
	type: "patch";
	sessionId: string;
	value: Partial<Omit<GuiSnapshot, "messages" | "entries" | "streamingMessage">>;
	messages?: Tail<GuiSnapshot["messages"][number]> | undefined;
	entries?: Tail<GuiSnapshot["entries"][number]> | undefined;
	streamingMessage?: StreamingPatch | undefined;
}
export type GuiWireEvent = Exclude<GuiEvent, { type: "stream" }> | GuiPatch;
export interface GuiDelivery { id: number; events: GuiWireEvent[] }

function tail<T>(before: T[], after: T[]): Tail<T> | undefined {
	let keep = 0;
	while (keep < before.length && before[keep] === after[keep]) keep++;
	return keep === before.length && keep === after.length ? undefined : { keep, items: after.slice(keep) };
}

function streamPatch(before: GuiSnapshot["streamingMessage"], after: GuiSnapshot["streamingMessage"]): StreamingPatch | undefined {
	if (before === after) return undefined;
	if (before?.role !== "assistant" || after?.role !== "assistant" || before.timestamp !== after.timestamp)
		return { kind: "replace", value: after };
	const blocks: BlockPatch[] = [];
	for (const [index, block] of after.content.entries()) {
		const old = before.content[index];
		if (old === block) continue;
		if (old?.type === "text" && block.type === "text" && old.textSignature === block.textSignature && block.text.startsWith(old.text)) {
			if (block.text !== old.text) blocks.push({ index, field: "text", delta: block.text.slice(old.text.length) });
		} else if (old?.type === "thinking" && block.type === "thinking" && old.thinkingSignature === block.thinkingSignature
			&& old.redacted === block.redacted && block.thinking.startsWith(old.thinking)) {
			if (block.thinking !== old.thinking) blocks.push({ index, field: "thinking", delta: block.thinking.slice(old.thinking.length) });
		} else if (JSON.stringify(old) !== JSON.stringify(block)) blocks.push({ index, value: block });
	}
	const { content: _before, ...oldMetadata } = before;
	const { content: _after, ...metadata } = after;
	const changed = JSON.stringify(oldMetadata) !== JSON.stringify(metadata);
	if (!blocks.length && !changed && before.content.length === after.content.length) return undefined;
	return { kind: "content", blocks, length: after.content.length, ...(changed ? { metadata } : {}) };
}

/** 已完成消息沿用引用，只传变化的尾部。流式正文和思考只传新增字符。 */
export function diffSnapshot(before: GuiSnapshot, after: GuiSnapshot): GuiPatch {
	const { messages, entries, streamingMessage, ...fields } = after;
	const value: GuiPatch["value"] = {};
	for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
		if (fields[key] !== before[key] && JSON.stringify(fields[key]) !== JSON.stringify(before[key]))
			Object.assign(value, { [key]: fields[key] });
	}
	return {
		type: "patch", sessionId: after.sessionId, value,
		messages: tail(before.messages, messages), entries: tail(before.entries, entries),
		streamingMessage: streamPatch(before.streamingMessage, streamingMessage),
	};
}

export function applyPatch(snapshot: GuiSnapshot, patch: GuiPatch): GuiSnapshot {
	let streamingMessage = snapshot.streamingMessage;
	const change = patch.streamingMessage;
	if (change?.kind === "replace") streamingMessage = change.value;
	else if (change?.kind === "content" && streamingMessage?.role === "assistant") {
		const content = streamingMessage.content.slice(0, change.length);
		for (const block of change.blocks) {
			if ("value" in block) content[block.index] = block.value;
			else {
				const old = content[block.index];
				if (block.field === "text" && old?.type === "text") content[block.index] = { ...old, text: old.text + block.delta };
				if (block.field === "thinking" && old?.type === "thinking") content[block.index] = { ...old, thinking: old.thinking + block.delta };
			}
		}
		streamingMessage = { ...streamingMessage, ...change.metadata, content };
	}
	return {
		...snapshot, ...patch.value, streamingMessage,
		messages: patch.messages ? [...snapshot.messages.slice(0, patch.messages.keep), ...patch.messages.items] : snapshot.messages,
		entries: patch.entries ? [...snapshot.entries.slice(0, patch.entries.keep), ...patch.entries.items] : snapshot.entries,
	};
}

export class GuiReceiver {
	private snapshot: GuiSnapshot | null = null;
	accept(event: GuiWireEvent): Exclude<GuiEvent, { type: "stream" }> {
		if (event.type === "snapshot") this.snapshot = event.value;
		if (event.type !== "patch") return event;
		if (!this.snapshot || this.snapshot.sessionId !== event.sessionId) throw new Error("会话增量缺少初始状态。");
		this.snapshot = applyPatch(this.snapshot, event);
		return { type: "snapshot", value: this.snapshot };
	}
}
