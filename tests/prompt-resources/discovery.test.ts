import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgentsPromptPaths } from "../../src/prompt-resources/discovery.js";

let dir: string;
const oldHome = process.env.HOME;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-prompt-resources-"));
	process.env.HOME = dir;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
});

describe("agents prompt resource discovery", () => {
	it("加载 ~/.agents/prompts 下的用户 prompt templates", async () => {
		const prompt = path.join(dir, ".agents", "prompts", "ask.md");
		await mkdir(path.dirname(prompt), { recursive: true });
		await writeFile(prompt, "---\ndescription: Ask\n---\nAsk $ARGUMENTS");

		expect(discoverAgentsPromptPaths({ cwd: dir, projectTrusted: false })).toEqual([prompt]);
	});

	it("projectTrusted 开启后加载祖先 .agents/prompts", async () => {
		const project = path.join(dir, "repo");
		const nested = path.join(project, "src");
		const prompt = path.join(project, ".agents", "prompts", "plan.md");
		await mkdir(path.join(project, ".git"), { recursive: true });
		await mkdir(path.dirname(prompt), { recursive: true });
		await mkdir(nested, { recursive: true });
		await writeFile(prompt, "---\ndescription: Plan\n---\nPlan $1");

		expect(discoverAgentsPromptPaths({ cwd: nested, projectTrusted: false })).not.toContain(prompt);
		expect(discoverAgentsPromptPaths({ cwd: nested, projectTrusted: true })).toContain(prompt);
	});

	it("项目扫描排除全局 ~/.agents/prompts", async () => {
		const prompt = path.join(dir, ".agents", "prompts", "home.md");
		await mkdir(path.dirname(prompt), { recursive: true });
		await writeFile(prompt, "---\ndescription: Home\n---\nHome");

		expect(discoverAgentsPromptPaths({ cwd: dir, projectTrusted: true })).toEqual([prompt]);
	});

	it("拒绝项目 .agents/prompts 符号链接逃逸", async () => {
		const project = path.join(dir, "repo");
		const outside = path.join(dir, "outside.md");
		const link = path.join(project, ".agents", "prompts", "outside.md");
		await writeFile(outside, "---\ndescription: Outside\n---\nOutside");
		await mkdir(path.dirname(link), { recursive: true });
		await symlink(outside, link);

		expect(discoverAgentsPromptPaths({ cwd: project, projectTrusted: true })).not.toContain(link);
	});
});
