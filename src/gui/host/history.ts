import { sessionEntryToContextMessages, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { PRUNE_STATE, parsePruneState } from "../../harness/prune/prune.ts";
import type { GuiEntry } from "../messages.ts";
import type { GuiPayloads } from "./payloads.ts";

/** SDK 条目不可变，标签单独更新。历史正文投影一次，所有客户端共用。 */
export class GuiHistory {
	private cache = new WeakMap<SessionEntry, GuiEntry>();
	private entries: GuiEntry[] = [];
	private contextEntryIds: string[] = [];

	constructor(private payloads: GuiPayloads) {}

	project(manager: SessionManager) {
		const entries = manager.getEntries().map((entry) => {
			const label = manager.getLabel(entry.id);
			let value = this.cache.get(entry);
			if (!value) {
				const pruned = entry.type === "custom" && entry.customType === PRUNE_STATE ? parsePruneState(entry.data) : undefined;
				value = { id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp, label,
					messages: sessionEntryToContextMessages(entry).map((message) => this.payloads.message(message)),
					...(pruned ? { prunedToolCallIds: pruned.toolCallIds } : {}),
				};
			} else if (value.label !== label) value = { ...value, label };
			this.cache.set(entry, value);
			return value;
		});
		if (entries.length !== this.entries.length || entries.some((entry, index) => entry !== this.entries[index])) this.entries = entries;
		const ids = manager.buildContextEntries().map((entry) => entry.id);
		if (ids.length !== this.contextEntryIds.length || ids.some((id, index) => id !== this.contextEntryIds[index])) this.contextEntryIds = ids;
		return { entries: this.entries, contextEntryIds: this.contextEntryIds };
	}
}
