import { sessionEntryToContextMessages, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { PRUNE_STATE, parsePruneState } from "../../harness/prune/prune.ts";
import type { GuiEntry } from "../messages.ts";
import type { GuiPayloads } from "./payloads.ts";
import { restoreNestedMutations } from "./nested-mutations.ts";

/** SDK 条目不可变，标签单独更新。历史正文投影一次，所有客户端共用。 */
export class GuiHistory {
	private cache = new WeakMap<SessionEntry, GuiEntry>();
	private entries: GuiEntry[] = [];
	private contextEntryIds: string[] = [];
	private previous: {
		manager: SessionManager;
		header: ReturnType<SessionManager["getHeader"]>;
		count: number;
		leafId: string | null;
		value: { entries: GuiEntry[]; contextEntryIds: string[] };
	} | undefined;

	constructor(private payloads: GuiPayloads) {}

	project(manager: SessionManager) {
		const header = manager.getHeader();
		const count = manager.getEntryCount();
		const leafId = manager.getLeafId();
		const previous = this.previous;
		// 标签和上下文编辑也会追加条目，重载则更换 header。分支切换单独比较叶节点。
		if (previous?.manager === manager && previous.header === header && previous.count === count && previous.leafId === leafId)
			return previous.value;
		const entries = manager.getEntries().map((entry) => {
			const label = manager.getLabel(entry.id);
			let value = this.cache.get(entry);
			if (!value) {
				const pruned = entry.type === "custom" && entry.customType === PRUNE_STATE ? parsePruneState(entry.data) : undefined;
				value = { id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp, label,
					messages: sessionEntryToContextMessages(entry).map((message) => {
						const projected = this.payloads.message(message);
						return message.role === "toolResult" && message.nestedCalls
							? restoreNestedMutations(projected, manager.getBranch(entry.id), this.payloads) : projected;
					}),
					...(pruned ? { prunedToolCallIds: pruned.toolCallIds } : {}),
				};
			} else if (value.label !== label) value = { ...value, label };
			this.cache.set(entry, value);
			return value;
		});
		if (entries.length !== this.entries.length || entries.some((entry, index) => entry !== this.entries[index])) this.entries = entries;
		const ids = manager.buildContextEntries().map((entry) => entry.id);
		if (ids.length !== this.contextEntryIds.length || ids.some((id, index) => id !== this.contextEntryIds[index])) this.contextEntryIds = ids;
		const value = { entries: this.entries, contextEntryIds: this.contextEntryIds };
		this.previous = { manager, header, count, leafId, value };
		return value;
	}
}
