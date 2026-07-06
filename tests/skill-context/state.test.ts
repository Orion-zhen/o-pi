import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { computeSkillContextState } from "../../src/skill-context/state.js";
import { SKILL_CONTEXT_ENTRY, type SkillContextEntry } from "../../src/skill-context/types.js";

describe("skill context state", () => {
	it("activation 后 active", () => {
		const state = computeSkillContextState([custom("1", activation("demo"))]);
		expect(state.active.map((skill) => skill.name)).toEqual(["demo"]);
		expect(state.retained.map((skill) => skill.name)).toEqual(["demo"]);
	});

	it("lazy clear 后 inactive retained", () => {
		const state = computeSkillContextState([custom("1", activation("demo")), custom("2", deactivation("demo", "lazy"))]);
		expect(state.active).toHaveLength(0);
		expect(state.retained.map((skill) => skill.name)).toEqual(["demo"]);
	});

	it("hard clear 后不再 retained", () => {
		const state = computeSkillContextState([custom("1", activation("demo")), custom("2", deactivation("demo", "hard"))]);
		expect(state.active).toHaveLength(0);
		expect(state.retained).toHaveLength(0);
		expect([...state.hardClearedNames]).toEqual(["demo"]);
	});

	it("replace deactivation 让旧 skill inactive，新 skill active", () => {
		const state = computeSkillContextState([
			custom("1", activation("old")),
			custom("2", { kind: "deactivation", name: "old", mode: "lazy", reason: "conflict_replace", clearedAt: "t" }),
			custom("3", activation("new")),
		]);
		expect(state.active.map((skill) => skill.name)).toEqual(["new"]);
		expect(state.retained.map((skill) => skill.name)).toEqual(["old", "new"]);
	});

	it("clear all 清空 active", () => {
		const state = computeSkillContextState([
			custom("1", activation("a")),
			custom("2", activation("b")),
			custom("3", { kind: "deactivation", mode: "lazy", reason: "user_clear", clearedAt: "t" }),
		]);
		expect(state.active).toHaveLength(0);
		expect(state.retained.map((skill) => skill.name)).toEqual(["a", "b"]);
	});
});

function custom(id: string, data: SkillContextEntry): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY, data };
}

function activation(name: string): SkillContextEntry {
	return {
		kind: "activation",
		name,
		description: `${name} desc`,
		path: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		body: `${name} body`,
		contentHash: `${name}hash`,
		scope: "task",
		loadedAt: "dynamic-time",
	};
}

function deactivation(name: string, mode: "lazy" | "hard"): SkillContextEntry {
	return { kind: "deactivation", name, mode, reason: "user_clear", clearedAt: "dynamic-time" };
}

