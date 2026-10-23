import type { GuiEntry, GuiMessage } from "../../../shared/messages/types.ts";

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
	const result: GuiTreeNode[] = [];
	const pending = roots.reverse().map((node) => ({ node, target: result }));
	while (true) {
		const next = pending.pop();
		if (!next) break;
		const { node } = next;
		let { target } = next;
		if (visible(node.entry, leafId)) {
			const children: GuiTreeNode[] = [];
			target.push({ entry: node.entry, children });
			target = children;
		}
		const children = node.children;
		if (children.length > 1) children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp)).reverse();
		for (const child of children) pending.push({ node: child, target });
	}
	return result;
}
