import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildSystemPromptOptions, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSkillContextConfig } from "../../src/skill-context/config.js";
import { collectSkillCandidates, loadSkill } from "../../src/skill-context/loader.js";
import { useTempDir } from "../helpers/lifecycle.js";

let tempDir: string;
const temp = useTempDir("o-pi-skill-loader-");

beforeEach(() => {
	tempDir = temp.path;
});

describe("skill loader", () => {
	it("从 getCommands() 的 skill source 发现并 strip skill: 前缀", () => {
		const skillPath = path.join(tempDir, "demo", "SKILL.md");
		const candidates = collectSkillCandidates(undefined, [skillCommand("skill:demo", skillPath)]);
		expect(candidates).toMatchObject([{ name: "demo", path: skillPath, scope: "user" }]);
	});

	it("优先保留 systemPromptOptions.skills 中当前可见的第一个候选", () => {
		const options: BuildSystemPromptOptions = {
			cwd: tempDir,
			skills: [
				{
					name: "demo",
					description: "first",
					filePath: "/first/SKILL.md",
					baseDir: "/first",
					sourceInfo: { path: "/first/SKILL.md", source: "user", scope: "user", origin: "top-level" },
					disableModelInvocation: false,
				},
			],
		};
		const candidates = collectSkillCandidates(options, [skillCommand("skill:demo", "/second/SKILL.md")]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ name: "demo", path: "/first/SKILL.md", description: "first" });
	});

	it("host 侧读取 SKILL.md，body 不含 frontmatter", async () => {
		const dir = path.join(tempDir, "demo");
		await mkdir(dir);
		const skillPath = path.join(dir, "SKILL.md");
		await writeFile(skillPath, "---\nname: demo\ndescription: desc\n---\n\nbody\n");
		const loaded = await loadSkill({ name: "demo", path: skillPath, scope: "user" }, defaultSkillContextConfig());
		expect(loaded).toMatchObject({ name: "demo", description: "desc", path: skillPath, baseDir: dir, body: "body" });
		expect(loaded.contentHash).toMatch(/^[a-f0-9]{64}$/);
	});
});

function skillCommand(name: string, filePath: string): SlashCommandInfo {
	return {
		name,
		description: "desc",
		source: "skill",
		sourceInfo: { path: filePath, source: "user", scope: "user", origin: "top-level" },
	};
}
