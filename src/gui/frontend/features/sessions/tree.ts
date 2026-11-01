import type { GuiEntry, GuiMessage } from "../../../shared/messages/types.ts";

export type EntryMessage = Exclude<GuiMessage, { role: "system" | "toolResult" }>;

interface HistoryNode {
	entry: GuiEntry;
	children: HistoryNode[];
}

export interface GuiTreeNode {
	entry: GuiEntry;
	message: EntryMessage;
	children: GuiTreeNode[];
}

export function messageContent(message: EntryMessage) {
	return message.role === "bashExecution" ? message.command
		: message.role === "compactionSummary" || message.role === "branchSummary" ? message.summary : message.content;
}

export function entryMessage(entry: GuiEntry): EntryMessage | undefined {
	const message = entry.messages.find((message) => message.role !== "system");
	if (!message || message.role === "toolResult" || message.role === "custom" && !message.display) return undefined;
	return message;
}

export function hasEntryActions(message: EntryMessage): boolean {
	return message.role !== "assistant"
		|| (message.stopReason !== "stop" && message.stopReason !== "toolUse")
		|| message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

export function sessionTree(entries: GuiEntry[], leafId: string | null): GuiTreeNode[] {
	const nodes = new Map<string, HistoryNode>(entries.map((entry) => [entry.id, { entry, children: [] }]));
	const roots: HistoryNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.entry.parentId !== node.entry.id && node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
		(parent?.children ?? roots).push(node);
	}
	const result: GuiTreeNode[] = [];
	const pending = roots.reverse().map((node) => ({ node, target: result }));
	while (true) {
		const next = pending.pop();
		if (!next) break;
		const { node } = next;
		let { target } = next;
		const message = entryMessage(node.entry);
		if (message && (node.entry.id === leafId || hasEntryActions(message))) {
			const children: GuiTreeNode[] = [];
			target.push({ entry: node.entry, message, children });
			target = children;
		}
		const children = node.children;
		if (children.length > 1) children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp)).reverse();
		for (const child of children) pending.push({ node: child, target });
	}
	return result;
}
