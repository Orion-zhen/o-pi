import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SKILL_CONTEXT_ENTRY, type SkillLoadEntry, type SkillStatusSnapshot } from "./types.ts";

/** 追加分支只读取新增条目，切换分支或会话时从当前叶节点重建。 */
export class SkillBranchState {
	private sessionId: string | undefined;
	private leafId: string | null = null;
	private readonly loads = new Map<string, SkillLoadEntry>();

	read(manager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getEntry">): ReadonlyMap<string, SkillLoadEntry> {
		const sessionId = manager.getSessionId();
		if (sessionId !== this.sessionId) {
			this.loads.clear();
			this.leafId = null;
			this.sessionId = sessionId;
		}
		const leaf = manager.getLeafId();
		const pending: SessionEntry[] = [];
		let cursor = leaf;
		while (cursor !== null && cursor !== this.leafId) {
			const entry = manager.getEntry(cursor);
			if (entry === undefined) throw new Error(`Missing session entry: ${cursor}`);
			pending.push(entry);
			cursor = entry.parentId;
		}
		if (cursor !== this.leafId) this.loads.clear();
		for (const entry of pending.reverse()) {
			if (entry.type === "custom" && entry.customType === SKILL_CONTEXT_ENTRY && isSkillLoadEntry(entry.data)) {
				this.loads.set(entry.data.name, entry.data);
			}
		}
		this.leafId = leaf;
		return this.loads;
	}
}

export function extractSkillLoads(branchEntries: SessionEntry[]): SkillLoadEntry[] {
	const loads: SkillLoadEntry[] = [];
	for (const entry of branchEntries) {
		if (entry.type !== "custom" || entry.customType !== SKILL_CONTEXT_ENTRY) continue;
		if (isSkillLoadEntry(entry.data)) loads.push(entry.data);
	}
	return loads;
}

/** 返回当前分支中每个精确技能名称最后披露的版本。 */
export function loadedSkillsByName(branchEntries: SessionEntry[]): Map<string, SkillLoadEntry> {
	const loaded = new Map<string, SkillLoadEntry>();
	for (const entry of extractSkillLoads(branchEntries)) loaded.set(entry.name, entry);
	return loaded;
}

/** 返回 adapter-facing 的当前分支技能披露快照。 */
export function querySkillStatus(branchEntries: SessionEntry[]): SkillStatusSnapshot {
	return {
		skills: [...loadedSkillsByName(branchEntries).values()].map((load) => ({
			name: load.name,
			scope: load.scope,
			loadedBy: load.loadedBy,
		})),
	};
}

export function hasCurrentDisclosure(
	branchEntries: SessionEntry[],
	skill: SkillLoadEntry,
	visibleToolCallIds?: ReadonlySet<string>,
): boolean {
	const current = loadedSkillsByName(branchEntries).get(skill.name);
	if (current?.contentHash !== skill.contentHash
		|| current.path !== skill.path
		|| current.root !== skill.root
		|| current.scope !== skill.scope) return false;

	if (current.loadedBy === "manual") return true;
	return current.toolCallId !== undefined && visibleToolCallIds?.has(current.toolCallId) === true;
}

function isSkillLoadEntry(value: unknown): value is SkillLoadEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<SkillLoadEntry>;
	return typeof entry.name === "string"
		&& typeof entry.root === "string"
		&& typeof entry.path === "string"
		&& typeof entry.contentHash === "string"
		&& (entry.scope === "user" || entry.scope === "project" || entry.scope === "temporary")
		&& (entry.loadedBy === "agent" || entry.loadedBy === "manual")
		&& (entry.toolCallId === undefined || typeof entry.toolCallId === "string");
}
