import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";

export function workbenchTests(context: () => { host: GuiHost; cwd: string; events: GuiEvent[] }) {
	describe("GUI 工作台读取边界", () => {
		it("请求按工作区和 ID 回传，不修改会话或产生快照反馈", async () => {
			const { host, cwd, events } = context();
			const before = host.snapshot();
			const start = events.length;
			await Promise.all([
				host.dispatch({ action: "workspaceFiles", cwd, path: "", requestId: "tree" }),
				host.dispatch({ action: "previewFile", cwd, path: "input.txt", requestId: "preview" }),
				host.dispatch({ action: "workspaceGit", cwd, requestId: "git" }),
			]);
			const replies = events.slice(start).filter((event) => event.type === "workbench");
			expect(replies).toHaveLength(3);
			expect(replies.find((event) => event.requestId === "preview")).toMatchObject({ cwd, result: { kind: "preview", preview: { path: "input.txt", content: { kind: "text", text: "input\n" } } } });
			expect(events.slice(start).filter((event) => event.type === "snapshot")).toEqual([]);
			expect(host.snapshot()).toEqual(before);
		});

		it("旧工作区请求和越界请求返回独立错误，当前工作区仍可读取", async () => {
			const { host, cwd, events } = context();
			const next = path.join(cwd, "next");
			await mkdir(next);
			await writeFile(path.join(next, "next.txt"), "next workspace\n");
			await host.dispatch({ action: "workspace", path: next });
			await host.dispatch({ action: "previewFile", cwd, path: "input.txt", requestId: "old" });
			await host.dispatch({ action: "previewFile", cwd: next, path: "../input.txt", requestId: "escape" });
			await host.dispatch({ action: "previewFile", cwd: next, path: "next.txt", requestId: "current" });
			const replies = events.filter((event) => event.type === "workbench");
			expect(replies.find((event) => event.requestId === "old")?.result).toMatchObject({ kind: "error", message: expect.stringContaining("工作区已切换") });
			expect(replies.find((event) => event.requestId === "escape")?.result).toMatchObject({ kind: "error", message: expect.stringContaining("超出") });
			expect(replies.find((event) => event.requestId === "current")?.result.kind).toBe("preview");
		});

		it("模型运行期间仍可浏览和预览文件", async () => {
			const { host, cwd, events } = context();
			const prompt = host.dispatch({ action: "prompt", text: "执行真实工具", images: [], behavior: "followUp" });
			await host.dispatch({ action: "previewFile", cwd, path: "input.txt", requestId: "during-prompt" });
			expect(events.find((event) => event.type === "workbench" && event.requestId === "during-prompt")).toMatchObject({ result: { kind: "preview" } });
			await prompt;
		});
	});
}
