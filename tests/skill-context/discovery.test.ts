import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { beforeEach, describe, expect, it } from "vitest";
import projectSkillsExtension from "../../agent/extensions/project-skills.js";
import { discoverAncestorPiSkillPaths } from "../../src/skill-context/discovery.js";
import { useTempDir } from "../helpers/lifecycle.js";

interface ResourcesEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

interface ResourcesContext {
	isProjectTrusted(): boolean;
}

interface ResourcesResult {
	skillPaths?: string[];
}

type ResourcesHandler = (event: ResourcesEvent, ctx: ResourcesContext) => ResourcesResult | Promise<ResourcesResult>;

let dir: string;
const temp = useTempDir("o-pi-project-skills-");

beforeEach(() => {
	dir = temp.path;
});

describe("project skill discovery", () => {
	it("从 cwd 的父目录向上发现 .pi/skills，并在 Git 根停止", async () => {
		const repo = path.join(dir, "repo");
		const workspace = path.join(repo, "packages");
		const cwd = path.join(workspace, "app");
		const cwdSkills = path.join(cwd, ".pi", "skills");
		const workspaceSkills = path.join(workspace, ".pi", "skills");
		const repoSkills = path.join(repo, ".pi", "skills");
		const outsideSkills = path.join(dir, ".pi", "skills");
		await Promise.all([
			mkdir(path.join(repo, ".git"), { recursive: true }),
			mkdir(cwdSkills, { recursive: true }),
			mkdir(workspaceSkills, { recursive: true }),
			mkdir(repoSkills, { recursive: true }),
			mkdir(outsideSkills, { recursive: true }),
		]);

		expect(discoverAncestorPiSkillPaths({ cwd, projectTrusted: true })).toEqual([
			workspaceSkills,
			repoSkills,
		]);
	});

	it("项目未受信任时不暴露祖先 .pi/skills", async () => {
		const cwd = path.join(dir, "repo", "src");
		await mkdir(path.join(dir, "repo", ".pi", "skills"), { recursive: true });

		expect(discoverAncestorPiSkillPaths({ cwd, projectTrusted: false })).toEqual([]);
	});

	it("通过 resources_discover 暴露的目录可被 Pi 加载", async () => {
		const repo = path.join(dir, "repo");
		const cwd = path.join(repo, "src");
		const skillDir = path.join(repo, ".pi", "skills", "project-demo");
		const skillFile = path.join(skillDir, "SKILL.md");
		await mkdir(path.join(repo, ".git"), { recursive: true });
		await mkdir(cwd, { recursive: true });
		await mkdir(skillDir, { recursive: true });
		await writeFile(skillFile, "---\nname: project-demo\ndescription: Project demo\n---\nBody\n");

		let handler: ResourcesHandler | undefined;
		projectSkillsExtension({
			on: ((event: string, candidate: ResourcesHandler) => {
				if (event === "resources_discover") handler = candidate;
			}) as ExtensionAPI["on"],
		});
		const result = await handler?.(
			{ type: "resources_discover", cwd, reason: "startup" },
			{ isProjectTrusted: () => true },
		);

		expect(result?.skillPaths).toEqual([path.join(repo, ".pi", "skills")]);
		const loaded = loadSkills({
			cwd,
			agentDir: path.join(dir, "agent"),
			skillPaths: result?.skillPaths ?? [],
			includeDefaults: false,
		});
		expect(loaded.skills).toMatchObject([{ name: "project-demo", filePath: skillFile }]);
	});
});
