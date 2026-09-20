import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";

function isVisible(entry: SessionEntry, leafId: string | null): boolean {
	switch (entry.type) {
		case "usage":
		case "label":
		case "custom":
		case "model_change":
		case "thinking_level_change":
		case "session_info":
			return false;
		case "custom_message": return entry.display;
		case "message": {
			const message = entry.message;
			if (message.role === "system" || message.role === "toolResult" || (message.role === "custom" && !message.display)) return false;
			if (message.role !== "assistant" || entry.id === leafId) return true;
			return (
				message.content.some((block) => block.type === "text" && block.text.trim().length > 0) ||
				(message.stopReason !== "stop" && message.stopReason !== "toolUse")
			);
		}
		default:
			return true;
	}
}

export function filterSessionTreeNoTools(nodes: SessionTreeNode[], leafId: string | null): SessionTreeNode[] {
	return nodes.flatMap((node) => {
		const children = filterSessionTreeNoTools(node.children, leafId);
		return isVisible(node.entry, leafId) ? [{ ...node, children }] : children;
	});
}
