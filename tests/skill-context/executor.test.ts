import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeSkillLoad } from "../../src/skill-context/executor.js";
import { SKILL_CONTEXT_ENTRY, type SkillCandidate, type SkillLoadEntry } from "../../src/skill-context/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-skill-executor-");
let tempDir: string;

beforeEach(() => {
	tempDir = temp.path;
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
});

describe("技能加载执行器", () => {
	it("模型只能加载允许模型加载的技能，并获得极简披露", async () => {
		const allowed = await candidate("allowed", false, "Use this method.");
		const hidden = await candidate("hidden", true, "Manual only.");
		const entries: SkillLoadEntry[] = [];
		const result = await executeSkillLoad(fakePi(entries), {
			name: "allowed", loadedBy: "agent", candidates: [allowed, hidden], branch: [], toolCallId: "skill-1", visibleToolCallIds: new Set(),
		});

		expect(result.content).toBe('<invoked_skill root="skill://allowed"/>\n\nUse this method.');
		expect(result.content).not.toContain("description:");
		expect(result.content).not.toContain(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			name: "allowed",
			loadedBy: "agent",
			loadedAt: "2026-07-21T00:00:00.000Z",
			toolCallId: "skill-1",
		});
		expect(entries[0]).not.toHaveProperty("body");
		expect(entries[0]).not.toHaveProperty("description");
		expect(entries[0]).not.toHaveProperty("disableModelInvocation");

		await expect(executeSkillLoad(fakePi(entries), {
			name: "hidden", loadedBy: "agent", candidates: [allowed, hidden], branch: [], toolCallId: "skill-2", visibleToolCallIds: new Set(),
		})).rejects.toThrow("disables model invocation");
	});

	it("手动加载可以披露任意已发现技能", async () => {
		const hidden = await candidate("hidden", true, "Manual only.");
		const entries: SkillLoadEntry[] = [];
		const result = await executeSkillLoad(fakePi(entries), {
			name: "hidden", loadedBy: "manual", candidates: [hidden], branch: [],
		});
		expect(result.content).toContain("Manual only.");
		expect(entries[0]).toMatchObject({ name: "hidden", loadedBy: "manual" });
		expect(entries[0]).not.toHaveProperty("disableModelInvocation");
	});

	it("当前内容哈希相同时去重，内容变化或恢复旧版本时重新披露", async () => {
		const demo = await candidate("demo", false, "v1");
		const branch: SessionEntry[] = [];
		const appended: SkillLoadEntry[] = [];
		const pi = {
			appendEntry(_type: string, entry?: SkillLoadEntry) {
				if (entry === undefined) return;
				appended.push(entry);
				branch.push(custom(String(branch.length + 1), entry));
			},
		};
		const input = {
			name: "demo",
			loadedBy: "agent" as const,
			candidates: [demo],
			branch,
			toolCallId: "skill-1",
			visibleToolCallIds: new Set(["skill-1"]),
		};
		await executeSkillLoad(pi, input);
		const duplicate = await executeSkillLoad(pi, input);
		expect(duplicate.details.deduplicated).toBe(true);
		expect(duplicate.content).toBe('<invoked_skill root="skill://demo"/>');
		expect(appended).toHaveLength(1);

		const manualDuplicate = await executeSkillLoad(pi, {
			name: "demo",
			loadedBy: "manual",
			candidates: [demo],
			branch,
			visibleToolCallIds: new Set(["skill-1"]),
		});
		expect(manualDuplicate.details.deduplicated).toBe(true);
		expect(appended).toHaveLength(1);

		await writeSkill(demo.path, "demo", false, "v2");
		const changed = await executeSkillLoad(pi, input);
		expect(changed.details.deduplicated).toBe(false);
		expect(changed.content).toContain("v2");
		expect(appended).toHaveLength(2);

		await writeSkill(demo.path, "demo", false, "v1");
		const restored = await executeSkillLoad(pi, input);
		expect(restored.details.deduplicated).toBe(false);
		expect(restored.content).toContain("v1");
		expect(appended).toHaveLength(3);
	});

	it("技能 tool transaction 被连续 prune 后每次都重新披露正文", async () => {
		const demo = await candidate("demo", false, "body");
		const branch: SessionEntry[] = [];
		const appended: SkillLoadEntry[] = [];
		const pi = {
			appendEntry(_type: string, entry?: SkillLoadEntry) {
				if (entry === undefined) return;
				appended.push(entry);
				branch.push(custom(String(branch.length + 1), entry));
			},
		};

		const first = await executeSkillLoad(pi, {
			name: "demo", loadedBy: "agent", candidates: [demo], branch,
			toolCallId: "skill-1", visibleToolCallIds: new Set(),
		});
		expect(first.details.deduplicated).toBe(false);

		const duplicate = await executeSkillLoad(pi, {
			name: "demo", loadedBy: "agent", candidates: [demo], branch,
			toolCallId: "skill-2", visibleToolCallIds: new Set(["skill-1"]),
		});
		expect(duplicate.details.deduplicated).toBe(true);

		const afterFirstPrune = await executeSkillLoad(pi, {
			name: "demo", loadedBy: "agent", candidates: [demo], branch,
			toolCallId: "skill-3", visibleToolCallIds: new Set(),
		});
		expect(afterFirstPrune.details.deduplicated).toBe(false);

		const afterSecondPrune = await executeSkillLoad(pi, {
			name: "demo", loadedBy: "agent", candidates: [demo], branch,
			toolCallId: "skill-4", visibleToolCallIds: new Set(),
		});
		expect(afterSecondPrune.details.deduplicated).toBe(false);
		expect(appended).toHaveLength(3);
	});
});

async function candidate(name: string, disableModelInvocation: boolean, body: string): Promise<SkillCandidate> {
	const dir = path.join(tempDir, name);
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	await writeSkill(file, name, disableModelInvocation, body);
	return { name, path: file, disableModelInvocation, scope: "project" };
}

async function writeSkill(file: string, name: string, disableModelInvocation: boolean, body: string): Promise<void> {
	await writeFile(file, `---\nname: ${name}\ndescription: ${name} desc\ndisable-model-invocation: ${disableModelInvocation}\n---\n${body}\n`);
}

function fakePi(entries: SkillLoadEntry[]): { appendEntry(type: string, entry?: SkillLoadEntry): void } {
	return { appendEntry(_type, entry) { if (entry !== undefined) entries.push(entry); } };
}

function custom(id: string, data: SkillLoadEntry): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY, data };
}
