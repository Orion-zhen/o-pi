import type { GuiSnapshot } from "../../contract.ts";
import type { GuiEntry, GuiMessage } from "../../messages.ts";

type ContextHistory = Pick<GuiSnapshot, "entries" | "contextEntryIds">;
type History = ContextHistory & Pick<GuiSnapshot, "leafId">;

function indexHistory(snapshot: ContextHistory) {
	const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
	// 上下文 ID 与条目由同一次宿主投影生成，增量合并后一起交给界面。
	const context = snapshot.contextEntryIds.map((id) => byId.get(id) as GuiEntry);
	return { byId, context };
}

export function contextMessages(snapshot: ContextHistory): GuiMessage[] {
	return indexHistory(snapshot).context.flatMap((entry) => entry.messages);
}

export function hasContextMessages(snapshot: ContextHistory): boolean {
	const ids = new Set(snapshot.contextEntryIds);
	return snapshot.entries.some((entry) => ids.has(entry.id) && entry.messages.length > 0);
}

export function isTranscriptPreview(snapshot: ContextHistory, target: string | undefined): boolean {
	const entry = target ? snapshot.entries.find((entry) => entry.id === target) : undefined;
	return Boolean(entry && !(snapshot.contextEntryIds.includes(entry.id) && entry.messages.length > 0));
}

/** 旧分支和已压缩消息只读预览，不改变 SDK 的活动分支。 */
export function locateTranscript(snapshot: History, target: string | undefined) {
	const { byId, context } = indexHistory(snapshot);
	const ancestors = (id: string | null): GuiEntry[] => {
		const branch: GuiEntry[] = [];
		let entry = id ? byId.get(id) : undefined;
		while (entry) { branch.push(entry); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
		return branch.reverse();
	};
	const preview = isTranscriptPreview(snapshot, target);
	const branch = ancestors(preview && target ? target : snapshot.leafId);
	const entries = preview ? branch : context;
	const messages: GuiMessage[] = [];
	const entryIds: string[] = [];
	for (const entry of entries) for (const message of entry.messages) {
		messages.push(message);
		entryIds.push(entry.id);
	}
	return { messages, entryIds, preview,
		contextCount: preview ? context.reduce((count, entry) => count + entry.messages.length, 0) : messages.length,
		prunedToolCallIds: new Set(branch.findLast((entry) => entry.prunedToolCallIds !== undefined)?.prunedToolCallIds ?? []),
	};
}
