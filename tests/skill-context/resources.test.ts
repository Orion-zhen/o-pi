import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fileTools from "../../agent/extensions/file-tools.js";
import type { FilesystemPathAccess } from "../../src/filesystem/contracts/access.js";
import {
	buildSkillFilesystemAccess,
	buildSkillPathIndex,
	resolveSkillResourceLocator,
	type SkillPathIndex,
} from "../../src/skill-context/resources.js";
import { executeRead } from "../../src/file-tools/pi/adapters/read.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { SKILL_CONTEXT_ENTRY, type SkillCandidate, type SkillLoadEntry } from "../../src/skill-context/types.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { executeTool, registerExtension } from "../file-tools/extension-fixture.js";

const temp = useTempDir("o-pi-skill-resource-");
let root: string;
let candidate: SkillCandidate;
let branch: SessionEntry[];
let skillIndex: SkillPathIndex;
let pathAccess: FilesystemPathAccess;

beforeEach(async () => {
	root = path.join(temp.path, "demo");
	await mkdir(path.join(root, "references"), { recursive: true });
	await writeFile(path.join(root, "SKILL.md"), "skill");
	await writeFile(path.join(root, "references", "testing.md"), "testing");
	candidate = { name: "demo", path: path.join(root, "SKILL.md"), scope: "project" };
	branch = [custom(load("demo", root))];
	skillIndex = buildSkillPathIndex([candidate]);
	pathAccess = await buildSkillFilesystemAccess(branch, skillIndex);
});

describe("技能资源定位符", () => {
	it("canonical root 索引在扩展生命周期内复用同一解析任务", async () => {
		const first = skillIndex.canonicalRoots();
		expect(skillIndex.canonicalRoots()).toBe(first);
		expect(await first).toEqual([root]);
	});

	it("解析已授权资源并保留逻辑地址", async () => {
		const rootResult = await resolveSkillResourceLocator("skill://demo", branch);
		expect(rootResult).toMatchObject({ kind: "skill", logicalPath: "skill://demo", relativePath: "" });

		const result = await resolveSkillResourceLocator("skill://demo/references/testing.md", branch);
		expect(result).toMatchObject({
			kind: "skill",
			logicalPath: "skill://demo/references/testing.md",
			skillName: "demo",
			relativePath: "references/testing.md",
		});
		expect("filePath" in result ? result.filePath : "").toBe(path.join(root, "references", "testing.md"));
	});

	it("read 输出只展示逻辑 URI、跳过 LSP 并记录可编辑版本", async () => {
		const enhanceRead = vi.fn();
		const host = new FileToolsHost();
		const result = await executeRead({ path: "skill://demo/references/testing.md" }, {
			cwd: temp.path,
			sessionId: "skill-read",
			model: undefined,
			host,
			lsp: { read: enhanceRead },
			pathAccess,
		});
		const opened = await host.open({ cwd: temp.path, sessionId: "skill-read" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const file = await opened.filesystem.paths.resolveExisting(path.join(root, "references", "testing.md"), { expected: "file", followFinalSymlink: true });
		expect(file.ok && opened.observation.get(file.value)).toMatchObject({ sizeBytes: 7 });
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
	});

	it("所有文件工具通过逻辑根访问并修改已加载技能", async () => {
		await writeFile(path.join(root, "SKILL.md"), "before\n");
		const command = {
			name: "skill:demo",
			description: "demo",
			source: "skill",
			sourceInfo: { path: path.join(root, "SKILL.md"), scope: "project" },
		} as SlashCommandInfo;
		const { registered, handlers } = registerExtension(fileTools, { getCommands: () => [command] });
		const ctx = {
			cwd: temp.path,
			sessionManager: { getSessionId: () => "skill-filesystem", getBranch: () => branch },
		};
		try {
			const listed = await executeTool(registered, "ls", { path: "skill://demo" }, ctx);
			expect(listed.details).toMatchObject({
				path: "skill://demo",
				entries: expect.arrayContaining([
					expect.objectContaining({ path: "skill://demo/references", type: "directory" }),
					expect.objectContaining({ path: "skill://demo/SKILL.md", type: "file" }),
				]),
			});

			const found = await executeTool(registered, "find", { query: "testing", path: ["skill://demo"] }, ctx);
			expect(found.details).toMatchObject({ matches: [{ path: "skill://demo/references/testing.md", kind: "file" }] });

			const grepped = await executeTool(registered, "grep", {
				query: "testing",
				path: ["skill://demo/references"],
			}, ctx);
			expect(grepped.details).toMatchObject({
				status: "success",
				regions: expect.arrayContaining([expect.objectContaining({ path: "skill://demo/references/testing.md" })]),
			});
			for (const result of [listed, found, grepped]) expect(JSON.stringify(result)).not.toContain(root);

			await executeTool(registered, "read", { path: "skill://demo/SKILL.md" }, ctx);
			const edited = await executeTool(registered, "edit", {
				path: "skill://demo/SKILL.md",
				edits: [{ old: "before", new: "after" }],
			}, ctx);
			expect(edited.details).toMatchObject({ status: "applied", path: "skill://demo/SKILL.md" });
			expect(await readFile(path.join(root, "SKILL.md"), "utf8")).toBe("after\n");

			const written = await executeTool(registered, "write", {
				path: "skill://demo/references/new.md",
				content: "new resource",
			}, ctx);
			expect(written.details).toMatchObject({ status: "written", path: "skill://demo/references/new.md" });
			expect(await readFile(path.join(root, "references", "new.md"), "utf8")).toBe("new resource");
		} finally {
			await handlers.get("session_shutdown")?.({}, {});
		}
	});

	it("read PDF 输出重写为 Skill 逻辑地址并保留逐页图片", async () => {
		const pdfPath = path.join(root, "references", "document.pdf");
		await writeFile(pdfPath, await readFile(new URL("../file-tools/fixtures/read/two-page.pdf", import.meta.url)));
		const host = new FileToolsHost();
		try {
			const result = await executeRead({ path: "skill://demo/references/document.pdf", pages: "2" }, {
				cwd: temp.path,
				sessionId: "skill-pdf-read",
				model: { input: ["text", "image"] },
				host,
				lsp: {},
				pathAccess,
			});
			expect(result.content).toHaveLength(3);
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining('path="skill://demo/references/document.pdf"'),
			});
			expect(result.details).toMatchObject({
				path: "skill://demo/references/document.pdf",
				media_type: "pdf",
				pages: [{ number: 2, label: "A-1" }],
				skill_resource: { skill: "demo", path: "references/document.pdf" },
			});
		} finally {
			host.dispose();
		}
	});

	it("拒绝未加载技能", async () => {
		const unloaded = await resolveSkillResourceLocator("skill://demo/references/testing.md", []);
		expect(unloaded).toMatchObject({ kind: "error", code: "access-denied" });
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
		const result = await resolveSkillResourceLocator(locator, branch);
		expect(result).toMatchObject({ kind: "error", code: "invalid-locator" });
	});

	it.skipIf(process.platform === "win32")("拒绝空字符以及真实路径解析后的符号链接逃逸", async () => {
		const outside = path.join(temp.path, "outside.md");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(root, "references", "escape.md"));
		expect(await resolveSkillResourceLocator("skill://demo/references/testing.md\0", branch))
			.toMatchObject({ kind: "error", code: "invalid-locator" });
		expect(await resolveSkillResourceLocator("skill://demo/references/escape.md", branch))
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
