import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GuiClient } from "../../src/gui/host/client.ts";

export function workbenchTests(context: () => { host: GuiClient; cwd: string }) {
	describe("GUI 工作台读取边界", () => {
		it("Git 状态与并发文件预览共享扫描，后续刷新仍读取外部变更", async () => {
			const { host, cwd } = context();
			await promisify(childProcess.execFile)("git", ["init", "-b", "main"], { cwd });
			await writeFile(path.join(cwd, "other.txt"), "other\n");
			const run = vi.spyOn(childProcess, "execFile");
			syncBuiltinESMExports();
			try {
				await Promise.all([
					host.query({ query: "workspaceGit", cwd }),
					host.query({ query: "previewFile", cwd, path: "input.txt" }),
					host.query({ query: "previewFile", cwd, path: "other.txt" }),
				]);
				const scans = () => run.mock.calls.filter(([command, args]) => command === "git" && Array.isArray(args) && args.includes("status"));
				expect(scans()).toHaveLength(1);
				await writeFile(path.join(cwd, "external.txt"), "external change\n");
				expect((await host.query({ query: "workspaceGit", cwd }))?.changes).toContainEqual({ path: "external.txt", status: "?" });
				expect(scans()).toHaveLength(2);
			} finally { run.mockRestore(); syncBuiltinESMExports(); }
		});
		it("模型运行期间可并发浏览目录和预览不同文件", async () => {
			const { host, cwd } = context();
			await writeFile(path.join(cwd, "other.txt"), "other\n");
			const prompt = host.dispatch({ action: "prompt", text: "执行真实工具", images: [], behavior: "followUp" });
			try {
				const [files, preview, other] = await Promise.all([
					host.query({ query: "workspaceFiles", cwd, path: "" }),
					host.query({ query: "previewFile", cwd, path: "input.txt" }),
					host.query({ query: "previewFile", cwd, path: "other.txt" }),
				]);
				expect(files).toContainEqual({ name: "input.txt", path: "input.txt", kind: "file" });
				expect(preview).toMatchObject({ path: "input.txt", content: { kind: "text", text: "input\n" } });
				expect(other).toMatchObject({ path: "other.txt", content: { kind: "text", text: "other\n" } });
			} finally { await prompt; }
		});

		it("切换工作区后拒绝旧目录及越界读取，当前文件仍可预览", async () => {
			const { host, cwd } = context();
			const next = path.join(cwd, "next");
			await mkdir(next);
			await writeFile(path.join(next, "next.txt"), "next workspace\n");
			await host.dispatch({ action: "workspace", path: next });
			await expect(host.query({ query: "previewFile", cwd, path: "input.txt" })).rejects.toThrow();
			await expect(host.query({ query: "previewFile", cwd: next, path: "../input.txt" })).rejects.toThrow();
			expect(await host.query({ query: "previewFile", cwd: next, path: "next.txt" }))
				.toMatchObject({ content: { kind: "text", text: "next workspace\n" } });
		});
	});
}
