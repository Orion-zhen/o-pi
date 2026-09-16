import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GuiHost } from "../../src/gui/host/host.ts";

export function workbenchTests(context: () => { host: GuiHost; cwd: string }) {
	describe("GUI 工作台读取边界", () => {
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
