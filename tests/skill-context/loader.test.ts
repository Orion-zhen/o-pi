import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildSystemPromptOptions, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { collectModelInvocableSkillIndex, collectSkillCandidates, loadSkill } from "../../src/skill-context/loader.js";
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

	it("同名时 project skill 始终覆盖 user skill", () => {
		const user = skillCommand("skill:demo", "/user/SKILL.md", "user");
		const project = skillCommand("skill:demo", "/project/SKILL.md", "project");
		expect(collectSkillCandidates(undefined, [user, project])).toMatchObject([
			{ name: "demo", path: "/project/SKILL.md", scope: "project" },
		]);
		expect(collectSkillCandidates(undefined, [project, user])).toMatchObject([
			{ name: "demo", path: "/project/SKILL.md", scope: "project" },
		]);
	});

	it("host 侧读取 SKILL.md，body 不含 frontmatter", async () => {
		const dir = path.join(tempDir, "demo");
		await mkdir(dir);
		const skillPath = path.join(dir, "SKILL.md");
		await writeFile(skillPath, "---\nname: demo\ndescription: desc\ndisable-model-invocation: false\n---\n\nbody\n");
		const loaded = await loadSkill({ name: "demo", path: skillPath, scope: "user" });
		expect(loaded).toMatchObject({ name: "demo", description: "desc", path: skillPath, root: dir, body: "body", scope: "user" });
		expect(loaded).not.toHaveProperty("disableModelInvocation");
		expect(loaded.contentHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("始终完整加载正文，不使用配置或长度上限", async () => {
		const dir = path.join(tempDir, "large");
		await mkdir(dir);
		const skillPath = path.join(dir, "SKILL.md");
		const body = "x".repeat(25_000);
		await writeFile(skillPath, `---\nname: large\ndescription: desc\ndisable-model-invocation: false\n---\n${body}\n`);
		const loaded = await loadSkill({ name: "large", path: skillPath, scope: "project" });
		expect(loaded.body).toBe(body);
	});

	it("模型索引直接使用 Pi 已解析的调用策略", () => {
		const options: BuildSystemPromptOptions = {
			cwd: tempDir,
			skills: [piSkill("allowed", false), piSkill("hidden", true)],
		};
		expect(collectModelInvocableSkillIndex(options)).toEqual([{ name: "allowed", description: "allowed desc" }]);
	});
});

function piSkill(name: string, disableModelInvocation: boolean): NonNullable<BuildSystemPromptOptions["skills"]>[number] {
	const filePath = path.join(tempDir, name, "SKILL.md");
	return {
		name,
		description: `${name} desc`,
		filePath,
		baseDir: path.dirname(filePath),
		disableModelInvocation,
		sourceInfo: { path: filePath, source: "user", scope: "user", origin: "top-level" },
	};
}

function skillCommand(name: string, filePath: string, scope: "user" | "project" = "user"): SlashCommandInfo {
	return {
		name,
		description: "desc",
		source: "skill",
		sourceInfo: { path: filePath, source: scope, scope, origin: "top-level" },
	};
}
