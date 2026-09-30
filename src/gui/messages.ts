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
export function outputPreview(output: GuiToolOutput | undefined): ToolOutput | undefined {
	return output?.kind === "inline" ? output.value : output?.preview;
}

export interface GuiNestedCalls {
	complete: boolean;
	calls: (Omit<NestedToolCallRecord, "arguments"> & { arguments?: unknown; output?: GuiToolOutput })[];
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
export interface GuiTreeNode {
	entry: GuiEntry;
	children: GuiTreeNode[];
}

export function entryMessage(entry: GuiEntry): GuiMessage | undefined {
	return entry.messages.find((message) => message.role !== "system");
}

function visible(entry: GuiEntry, leafId: string | null): boolean {
	const message = entryMessage(entry);
	if (!message || message.role === "toolResult" || message.role === "custom" && !message.display) return false;
	return message.role !== "assistant" || entry.id === leafId
		|| message.content.some((block) => block.type === "text" && block.text.trim().length > 0)
		|| message.stopReason !== "stop" && message.stopReason !== "toolUse";
}

export function sessionTree(entries: GuiEntry[], leafId: string | null): GuiTreeNode[] {
	const nodes = new Map(entries.map((entry) => [entry.id, { entry, children: [] as GuiTreeNode[] }]));
	const roots: GuiTreeNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.entry.parentId !== node.entry.id && node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
		(parent?.children ?? roots).push(node);
	}
	const filter = (nodes: GuiTreeNode[]): GuiTreeNode[] => nodes.flatMap((node) => {
		const children = filter(node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp)));
		return visible(node.entry, leafId) ? [{ ...node, children }] : children;
	});
	return filter(roots);
}
