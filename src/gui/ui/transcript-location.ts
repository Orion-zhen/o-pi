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
	branch.reverse();
	const candidates = branch.flatMap((entry) => {
		const message = entryMessage(entry);
		return message ? [{ id: entry.id, message }] : [];
	});
	let cursor = 0;
	const entryIds = snapshot.messages.map((message) => {
		for (let index = cursor; index < candidates.length; index++) {
			const item = candidates[index];
			if (item?.message.role === message.role && item.message.timestamp === message.timestamp) {
				cursor = index + 1;
				return item.id;
			}
		}
		return undefined;
	});
	const prunedToolCallIds = getPrunedToolCallIds(snapshot, branch);
	if (!target || entryIds.includes(target) || !byId.has(target)) return { source: snapshot, entryIds, preview: false, prunedToolCallIds };
	const ancestors: SessionEntry[] = [];
	entry = byId.get(target);
	while (entry) { ancestors.push(entry); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
	ancestors.reverse();
	const messages: AgentMessage[] = [];
	const ids: string[] = [];
	for (const entry of ancestors) {
		const message = entryMessage(entry);
		if (message) { messages.push(message); ids.push(entry.id); }
	}
	return {
		source: { messages, models: snapshot.models, messageDurations: snapshot.messageDurations, streamingMessage: null, liveTools: [], streaming: false, retrying: false },
		entryIds: ids,
		preview: true,
		prunedToolCallIds: getPrunedToolCallIds(snapshot, ancestors),
	};
}

function getPrunedToolCallIds(snapshot: GuiSnapshot, entries: readonly SessionEntry[]): ReadonlySet<string> {
	const latest = entries.findLast((entry) => Object.hasOwn(snapshot.prunedToolCallIdsByEntry, entry.id));
	return new Set(latest ? snapshot.prunedToolCallIdsByEntry[latest.id] : []);
}
