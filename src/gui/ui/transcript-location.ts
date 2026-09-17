import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GuiSnapshot } from "../contract.ts";

export function entryMessage(entry: SessionEntry): AgentMessage | undefined {
	const timestamp = Date.parse(entry.timestamp);
	switch (entry.type) {
		case "message": return entry.message;
		case "custom_message": return { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp };
		case "compaction": return { role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp };
		case "branch_summary": return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp };
		default: return undefined;
	}
}

/** 旧分支和已压缩消息只读预览，不改变 SDK 的活动分支。 */
export function locateTranscript(snapshot: GuiSnapshot, target: string | undefined) {
	const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	let entry = snapshot.leafId ? byId.get(snapshot.leafId) : undefined;
	while (entry) { branch.push(entry); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
	const candidates = branch.reverse().flatMap((entry) => {
		const message = entryMessage(entry);
		return message ? [{ id: entry.id, message }] : [];
	});
	let cursor = 0;
	const entryIds = snapshot.messages.map((message) => {
		const index = candidates.findIndex((item, index) => index >= cursor && item.message.role === message.role && item.message.timestamp === message.timestamp);
		if (index < 0) return undefined;
		cursor = index + 1;
		return candidates[index]?.id;
	});
	if (!target || entryIds.includes(target) || !byId.has(target)) return { source: snapshot, entryIds, preview: false };
	const ancestors: SessionEntry[] = [];
	entry = byId.get(target);
	while (entry) { ancestors.push(entry); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
	const messages: AgentMessage[] = [];
	const ids: string[] = [];
	for (const entry of ancestors.reverse()) {
		const message = entryMessage(entry);
		if (message) { messages.push(message); ids.push(entry.id); }
	}
	return {
		source: { messages, models: snapshot.models, messageDurations: snapshot.messageDurations, streamingMessage: null, liveTools: [], streaming: false, retrying: false },
		entryIds: ids,
		preview: true,
	};
}
