import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NestedToolCallRecord, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface GuiImage {
	type: "image";
	mimeType: string;
	imageId: string;
}
export type GuiContent = string | (TextContent | GuiImage)[];
export interface ToolOutput { content: unknown; details?: unknown }

export type GuiToolOutput =
	| { kind: "inline"; value: ToolOutput }
	| { kind: "reference"; id: string; preview: ToolOutput; facts: string };

export type GuiNestedCall = Omit<NestedToolCallRecord, "arguments"> & { arguments?: unknown; output?: GuiToolOutput };
export interface GuiNestedCalls {
	complete: boolean;
	calls: GuiNestedCall[];
}

type ContentMessage = Extract<AgentMessage, { role: "user" | "custom" }>;
type WithContent<T> = T extends ContentMessage ? Omit<T, "content"> & { content: GuiContent } : never;
export type GuiMessage =
	| Exclude<AgentMessage, { role: "user" | "custom" | "toolResult" }>
	| WithContent<ContentMessage>
	| (Omit<Extract<AgentMessage, { role: "toolResult" }>, "content" | "details" | "nestedCalls"> & { output: GuiToolOutput; nestedCalls?: GuiNestedCalls });

/** 正文只存在于条目中。当前上下文和消息树均引用条目身份。 */
export interface GuiEntry {
	id: string;
	parentId: string | null;
	type: SessionEntry["type"];
	timestamp: string;
	messages: GuiMessage[];
	label: string | undefined;
	prunedToolCallIds?: string[];
}

export type ToolState = "preparing" | "pending" | "running" | "completed" | "failed" | "stopped" | "unavailable";
