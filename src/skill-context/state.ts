import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SKILL_CONTEXT_ENTRY, type SkillLoadEntry } from "./types.js";

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
