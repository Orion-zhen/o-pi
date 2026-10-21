import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { SkillBranchState } from "../../../src/harness/skill-context/state.ts";
import { SKILL_CONTEXT_ENTRY, type SkillLoadEntry } from "../../../src/harness/skill-context/types.ts";

function load(name: string, root: string): SkillLoadEntry {
	return { name, root, path: `${root}/SKILL.md`, contentHash: root,
		scope: "project", loadedBy: "manual", loadedAt: "2026-01-01T00:00:00Z" };
}

it("技能授权随加载、重新加载、分支切换和新会话更新", () => {
	const manager = SessionManager.inMemory();
	const state = new SkillBranchState();
	const initial = manager.appendCustomEntry(SKILL_CONTEXT_ENTRY, load("one", "/skills/one"));
	expect(state.read(manager).get("one")?.root).toBe("/skills/one");
	manager.appendMessage({ role: "user", content: "重新加载技能", timestamp: 1 });
	manager.appendCustomEntry(SKILL_CONTEXT_ENTRY, load("one", "/skills/updated"));
	expect(state.read(manager).get("one")?.root).toBe("/skills/updated");
	manager.branch(initial);
	manager.appendCustomEntry(SKILL_CONTEXT_ENTRY, load("two", "/skills/two"));
	expect([...state.read(manager).keys()]).toEqual(["one", "two"]);
	expect(state.read(manager).get("one")?.root).toBe("/skills/one");
	manager.branch(initial);
	expect([...state.read(manager).keys()]).toEqual(["one"]);
	manager.newSession();
	expect(state.read(manager).size).toBe(0);
});
