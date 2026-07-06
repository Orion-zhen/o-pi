import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SKILL_CONTEXT_ENTRY, type LoadedSkill, type SkillActivationEntry, type SkillContextEntry, type SkillContextState } from "./types.js";

/** 从当前 session branch 的 append-only custom entries 计算 skill 激活、保留和 hard clear 状态。 */
export function computeSkillContextState(branchEntries: SessionEntry[]): SkillContextState {
	const entries = extractSkillEntries(branchEntries);
	const active = new Map<string, LoadedSkill>();
	const retained = new Map<string, LoadedSkill>();
	const hardClearedNames = new Set<string>();

	for (const entry of entries) {
		if (entry.kind === "activation") {
			const loaded = loadedFromActivation(entry);
			active.set(entry.name, loaded);
			retained.set(entry.name, loaded);
			hardClearedNames.delete(entry.name);
			continue;
		}

		const names = namesForDeactivation(entry.name, active, retained);
		for (const name of names) {
			active.delete(name);
			if (entry.mode === "hard") {
				retained.delete(name);
				hardClearedNames.add(name);
			}
		}
	}

	return { entries, active: [...active.values()], retained: [...retained.values()], hardClearedNames };
}

/** 找出会被 hard clear 物理省略的历史 activation；context hook 用它保持时间线语义。 */
export function hardOmittedActivationIndexes(entries: SkillContextEntry[]): Set<number> {
	const active = new Map<string, number>();
	const retained = new Map<string, Set<number>>();
	const omitted = new Set<number>();

	for (const [index, entry] of entries.entries()) {
		if (entry.kind === "activation") {
			active.set(entry.name, index);
			const indexes = retained.get(entry.name) ?? new Set<number>();
			indexes.add(index);
			retained.set(entry.name, indexes);
			continue;
		}
		if (entry.mode !== "hard") {
			for (const name of namesForDeactivation(entry.name, active, retained)) active.delete(name);
			continue;
		}
		for (const name of namesForDeactivation(entry.name, active, retained)) {
			active.delete(name);
			for (const activationIndex of retained.get(name) ?? []) omitted.add(activationIndex);
			retained.delete(name);
		}
	}

	return omitted;
}

export function extractSkillEntries(branchEntries: SessionEntry[]): SkillContextEntry[] {
	const entries: SkillContextEntry[] = [];
	for (const entry of branchEntries) {
		if (entry.type !== "custom" || entry.customType !== SKILL_CONTEXT_ENTRY) continue;
		if (isSkillContextEntry(entry.data)) entries.push(entry.data);
	}
	return entries;
}

function namesForDeactivation(name: string | undefined, active: Map<string, unknown>, retained: Map<string, unknown>): string[] {
	if (name !== undefined) return [name];
	return [...new Set([...active.keys(), ...retained.keys()])];
}

function loadedFromActivation(entry: SkillActivationEntry): LoadedSkill {
	return {
		name: entry.name,
		description: entry.description,
		path: entry.path,
		baseDir: entry.baseDir,
		body: entry.body,
		contentHash: entry.contentHash,
	};
}

function isSkillContextEntry(value: unknown): value is SkillContextEntry {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	const entry = value as { kind?: unknown };
	return entry.kind === "activation" || entry.kind === "deactivation";
}

