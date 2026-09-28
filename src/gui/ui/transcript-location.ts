import type { GuiSnapshot } from "../contract.ts";
import type { GuiEntry, GuiMessage } from "../messages.ts";

/** 旧分支和已压缩消息只读预览，不改变 SDK 的活动分支。 */
export function locateTranscript(snapshot: Pick<GuiSnapshot, "entries" | "contextEntryIds" | "leafId">, target: string | undefined) {
	const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
	const ancestors = (id: string | null): GuiEntry[] => {
		const branch: GuiEntry[] = [];
		let entry = id ? byId.get(id) : undefined;
		while (entry) { branch.push(entry); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
		return branch.reverse();
	};
	// 上下文 ID 与条目由同一次宿主投影生成，增量合并后一起交给界面。
	const context = snapshot.contextEntryIds.map((id) => byId.get(id) as GuiEntry);
	const currentTarget = target && context.some((entry) => entry.id === target && entry.messages.length > 0);
	const preview = !!target && byId.has(target) && !currentTarget;
	const branch = ancestors(preview ? target : snapshot.leafId);
	const entries = preview ? branch : context;
	const messages: GuiMessage[] = [];
	const entryIds: string[] = [];
	for (const entry of entries) for (const message of entry.messages) {
		messages.push(message);
		entryIds.push(entry.id);
	}
	return { messages, entryIds, preview,
		prunedToolCallIds: new Set(branch.findLast((entry) => entry.prunedToolCallIds !== undefined)?.prunedToolCallIds ?? []),
	};
}
