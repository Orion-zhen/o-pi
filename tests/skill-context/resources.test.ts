import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSkillReadIndex, resolveReadLocator, type SkillReadIndex } from "../../src/skill-context/resources.js";
import { executeRead } from "../../src/file-tools/pi/adapters/read.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { SKILL_CONTEXT_ENTRY, type SkillCandidate, type SkillLoadEntry } from "../../src/skill-context/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-skill-resource-");
let root: string;
let candidate: SkillCandidate;
let branch: SessionEntry[];
let skillIndex: SkillReadIndex;

beforeEach(async () => {
	root = path.join(temp.path, "demo");
	await mkdir(path.join(root, "references"), { recursive: true });
	await writeFile(path.join(root, "SKILL.md"), "skill");
	await writeFile(path.join(root, "references", "testing.md"), "testing");
	candidate = { name: "demo", path: path.join(root, "SKILL.md"), scope: "project" };
	branch = [custom(load("demo", root))];
	skillIndex = await buildSkillReadIndex([candidate]);
});

describe("技能资源定位符", () => {
	it("canonical root 索引在扩展生命周期内复用同一解析任务", async () => {
		const first = skillIndex.canonicalRoots();
		expect(skillIndex.canonicalRoots()).toBe(first);
		expect(await first).toEqual([root]);
	});

	it("解析已授权资源并保留逻辑地址", async () => {
		const result = await resolveReadLocator("skill://demo/references/testing.md", branch, skillIndex);
		expect(result).toMatchObject({
			kind: "skill",
			logicalPath: "skill://demo/references/testing.md",
			skillName: "demo",
			relativePath: "references/testing.md",
		});
		expect("filePath" in result ? result.filePath : "").toBe(path.join(root, "references", "testing.md"));
	});

	it("read 输出只展示逻辑 URI，并跳过 LSP、Repo Map 和可编辑版本缓存", async () => {
		const enhanceRead = vi.fn();
		const readContext = vi.fn();
		const host = new FileToolsHost();
		const result = await executeRead({ path: "skill://demo/references/testing.md" }, {
			cwd: temp.path,
			sessionId: "skill-read",
			model: undefined,
			host,
			lsp: { read: enhanceRead },
			repoMap: {
				query: {
					query: async () => undefined,
					readContext,
					syncMutation: async () => undefined,
				},
				formatReadContext: async () => undefined,
				formatImpact: async () => undefined,
			},
			branch,
			skillIndex,
		});
		const opened = await host.open({ cwd: temp.path, sessionId: "skill-read" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const file = await opened.filesystem.paths.resolveExisting(path.join(root, "references", "testing.md"), { expected: "file", followFinalSymlink: true }, opened.context);
		expect(file.ok && opened.observation.get(file.value)).toBeUndefined();
		opened.dispose();
		host.dispose();
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		expect(text).toContain('path="skill://demo/references/testing.md"');
		expect(text).not.toContain(root);
		expect(result.details).toMatchObject({
			path: "skill://demo/references/testing.md",
			skill_resource: { skill: "demo", path: "references/testing.md" },
		});
		expect(enhanceRead).not.toHaveBeenCalled();
		expect(readContext).not.toHaveBeenCalled();
	});

	it("拒绝未加载技能和对受管理根目录的绝对路径访问", async () => {
		const unloaded = await resolveReadLocator("skill://demo/references/testing.md", [], skillIndex);
		expect(unloaded).toMatchObject({ kind: "error", code: "access-denied" });

		const absolute = await resolveReadLocator(path.join(root, "references", "testing.md"), [], skillIndex);
		expect(absolute).toMatchObject({ kind: "error", code: "access-denied" });
	});

	it("拒绝通过受管理根目录外部的符号链接读取技能资源", async () => {
		const alias = path.join(temp.path, "skill-alias");
		await symlink(root, alias);
		const result = await resolveReadLocator(path.join(alias, "references", "testing.md"), [], skillIndex);
		expect(result).toMatchObject({ kind: "error", code: "access-denied" });
	});

	it("非 read 文件操作不会把 skill:// 当作系统路径", async () => {
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: temp.path, sessionId: "skill-path" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			await expect(opened.filesystem.paths.resolveTarget(
				"skill://demo/references/testing.md",
				{ followExistingSymlink: true },
				opened.context,
			)).resolves.toMatchObject({ ok: false, error: { code: "invalid-path" } });
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it.each([
		"skill://demo/../secret.md",
		"skill://demo/./testing.md",
		"skill://demo/references//testing.md",
		"skill://demo/references\\testing.md",
		"skill://demo/references/testing.md?raw=1",
		"skill://demo/references/testing.md#part",
		"skill://demo/%2e%2e/secret.md",
		"skill://demo/",
	])("拒绝格式错误或可能逃逸的定位符 %s", async (locator) => {
		const result = await resolveReadLocator(locator, branch, skillIndex);
		expect(result).toMatchObject({ kind: "error", code: "invalid-locator" });
	});

	it("拒绝空字符以及真实路径解析后的符号链接逃逸", async () => {
		const outside = path.join(temp.path, "outside.md");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(root, "references", "escape.md"));
		expect(await resolveReadLocator("skill://demo/references/testing.md\0", branch, skillIndex))
			.toMatchObject({ kind: "error", code: "invalid-locator" });
		expect(await resolveReadLocator("skill://demo/references/escape.md", branch, skillIndex))
			.toMatchObject({ kind: "error", code: "access-denied" });
	});
});

function load(name: string, skillRoot: string): SkillLoadEntry {
	return {
		name, path: path.join(skillRoot, "SKILL.md"), root: skillRoot, contentHash: "hash",
		scope: "project", loadedBy: "agent", loadedAt: "t",
	};
}

function custom(data: SkillLoadEntry): SessionEntry {
	return { type: "custom", id: "1", parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY, data };
}
