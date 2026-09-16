import { execFile } from "node:child_process";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { listWorkspaceFiles, previewWorkspaceFile } from "../../src/gui/host/workspace-files.ts";
import { readWorkspaceGit } from "../../src/gui/host/workspace-git.ts";
import { fileGitState } from "../../src/gui/workbench.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-workspace-files-");
let cwd: string;
let signal: AbortSignal;
const git = async (...args: string[]) => promisify(execFile)("git", args, { cwd });
const put = async (name: string, text: string | Buffer) => {
	await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
	await writeFile(path.join(cwd, name), text);
};
beforeEach(async () => {
	cwd = path.join(temp.path, "project");
	await mkdir(cwd);
	signal = new AbortController().signal;
});

async function repository() {
	await git("init", "-b", "main");
	await git("config", "user.name", "GUI Test");
	await git("config", "user.email", "gui@example.invalid");
	await git("config", "core.autocrlf", "false");
	await put(".gitignore", "node_modules/\ndist/\n*.log\n");
	await put("src/修改.ts", "original\n");
	await put("docs/deleted.md", "delete this\n");
	await put("old name.txt", "rename this\n");
	await git("add", ".");
	await git("commit", "-m", "initial");
}

describe("工作台文件与 Git 只读流程", () => {
	it("普通目录正常浏览、预览，文件和目录按层加载", async () => {
		await put("src/main.ts", "export const answer = 42;\n");
		await put(".env", "EXAMPLE=1\n");
		expect(await readWorkspaceGit(cwd, signal)).toBeNull();
		expect(await listWorkspaceFiles(cwd, "")).toEqual([
			{ name: "src", path: "src", kind: "directory" },
			{ name: ".env", path: ".env", kind: "file" },
		]);
		expect(await listWorkspaceFiles(cwd, "src")).toEqual([{ name: "main.ts", path: "src/main.ts", kind: "file" }]);
		expect(await previewWorkspaceFile(cwd, "src/main.ts", signal)).toEqual({ path: "src/main.ts", content: { kind: "text", text: "export const answer = 42;\n" }, diffs: [] });
	});

	it("忽略目录仍可浏览，变更、重命名、删除和未跟踪文件都有真实状态", async () => {
		await repository();
		await put("node_modules/pkg/index.js", "ignored dependency\n");
		await put("dist/build.log", "ignored output\n");
		await put("src/修改.ts", "changed\n");
		await put("new 中文.txt", "new file\n");
		await git("mv", "old name.txt", "renamed name.txt");
		await rm(path.join(cwd, "docs"), { recursive: true });
		const status = await readWorkspaceGit(cwd, signal);
		expect(status?.branch).toBe("main");
		expect(status?.changes).toEqual(expect.arrayContaining([
			{ path: "src/修改.ts", status: "M" }, { path: "new 中文.txt", status: "?" },
			{ path: "docs/deleted.md", status: "D" },
			{ path: "renamed name.txt", originalPath: "old name.txt", status: "R" },
		]));
		expect(fileGitState("node_modules/pkg/index.js", status).ignored).toBe(true);
		expect(fileGitState("src", status).descendants).toBe(1);
		expect((await listWorkspaceFiles(cwd, "")).map((entry) => entry.name)).toContain("node_modules");
		expect((await listWorkspaceFiles(cwd, "node_modules/pkg")).map((entry) => entry.name)).toEqual(["index.js"]);
		expect(await previewWorkspaceFile(cwd, "node_modules/pkg/index.js", signal)).toMatchObject({ content: { kind: "text", text: "ignored dependency\n" }, diffs: [] });
		const deleted = await previewWorkspaceFile(cwd, "docs/deleted.md", signal);
		expect(deleted.content.kind).toBe("deleted");
		expect(deleted.diffs[0]?.text).toContain("-delete this");
		const renamed = await previewWorkspaceFile(cwd, "renamed name.txt", signal);
		expect(renamed.diffs[0]?.text).toContain("rename from old name.txt");
		const untracked = await previewWorkspaceFile(cwd, "new 中文.txt", signal);
		expect(untracked.diffs[0]?.text).toContain("+new file");
	});

	it("暂存和未暂存差异分别保留，预览不会修改索引", async () => {
		await repository();
		await put("src/修改.ts", "staged\n");
		await git("add", "src/修改.ts");
		await put("src/修改.ts", "working\n");
		const before = (await git("status", "--porcelain=v1")).stdout;
		const preview = await previewWorkspaceFile(cwd, "src/修改.ts", signal);
		expect(preview.diffs.map((part) => part.title)).toEqual(["已暂存", "未暂存"]);
		expect(preview.diffs[0]?.text).toContain("+staged");
		expect(preview.diffs[1]?.text).toContain("+working");
		expect((await git("status", "--porcelain=v1")).stdout).toBe(before);
	});

	it("仓库子目录、符号链接工作区和 detached HEAD 都使用正确的相对路径", async () => {
		await repository();
		await put("src/修改.ts", "changed\n");
		await git("checkout", "--detach");
		const nested = await readWorkspaceGit(path.join(cwd, "src"), signal);
		expect(nested?.branch).toMatch(/^detached /);
		expect(nested?.changes).toEqual([{ path: "修改.ts", status: "M" }]);
		const linked = path.join(temp.path, "linked-project");
		await symlink(cwd, linked, "dir");
		expect((await readWorkspaceGit(linked, signal))?.changes).toEqual([{ path: "src/修改.ts", status: "M" }]);
	});

	it("尚无提交的仓库可显示分支和暂存差异，特殊文件名不作为 Git 参数解析", async () => {
		await git("init", "-b", "main");
		await put(":(glob)*.txt", "literal file\n");
		await git("--literal-pathspecs", "add", "--", ":(glob)*.txt");
		expect((await readWorkspaceGit(cwd, signal))?.branch).toBe("main");
		expect((await previewWorkspaceFile(cwd, ":(glob)*.txt", signal)).diffs[0]?.text).toContain("+literal file");
	});

	it("拒绝越界和外部符号链接，内部文件链接可读", async () => {
		await put("safe.txt", "inside\n");
		await writeFile(path.join(temp.path, "secret.txt"), "outside\n");
		await symlink(path.join(temp.path, "secret.txt"), path.join(cwd, "external"));
		await symlink(path.join(temp.path), path.join(cwd, "external-dir"), "dir");
		await symlink(path.join(cwd, "safe.txt"), path.join(cwd, "internal"));
		await expect(previewWorkspaceFile(cwd, "../secret.txt", signal)).rejects.toThrow("超出");
		await expect(previewWorkspaceFile(cwd, "external", signal)).rejects.toThrow("超出");
		await expect(listWorkspaceFiles(cwd, "external-dir")).rejects.toThrow("超出");
		await expect(previewWorkspaceFile(cwd, "external-dir/missing.txt", signal)).rejects.toThrow("超出");
		await expect(previewWorkspaceFile(cwd, path.join(cwd, "safe.txt"), signal)).rejects.toThrow("必须相对");
		expect((await previewWorkspaceFile(cwd, "internal", signal)).content).toEqual({ kind: "text", text: "inside\n" });
	});

	it("超限、二进制和非 UTF-8 文件明确说明不可预览，取消会终止读取", async () => {
		await put("large.txt", "x".repeat(512 * 1024 + 1));
		await put("binary.bin", Buffer.from([0, 1, 2, 3]));
		await put("encoding.txt", Buffer.from([255, 254, 253]));
		for (const name of ["large.txt", "binary.bin", "encoding.txt"])
			expect((await previewWorkspaceFile(cwd, name, signal)).content.kind).toBe("unavailable");
		const controller = new AbortController();
		controller.abort();
		await expect(previewWorkspaceFile(cwd, "large.txt", controller.signal)).rejects.toThrow();
		await rename(path.join(cwd, "binary.bin"), path.join(cwd, "moved.bin"));
		await expect(previewWorkspaceFile(cwd, "binary.bin", signal)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
