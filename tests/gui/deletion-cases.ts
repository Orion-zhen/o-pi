import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { prepareSessionDeletion } from "../../src/gui/host/delete-session.ts";
import { storeSession } from "./session-fixture.ts";

const prompt = { action: "prompt", text: "读取并写入文件", images: [], behavior: "followUp" };

export function historyDeletionTests(context: () => { host: GuiHost; cwd: string; agentDir: string; events: GuiEvent[] }) {
	describe("GUI 会话删除", () => {
		it("行内确认后直接删除共享会话，不弹窗、不删除项目文件", async () => {
			const { host, cwd, agentDir, events } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "待删除会话" });
			const retained = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "保留会话" });
			const settings = await readFile(path.join(agentDir, "settings.json"), "utf8");
			const id = host.snapshot().sessionId;
			const start = events.length;
			await host.dispatch({ action: "deleteSession", path: file });
			expect(events.slice(start).filter((event) => event.type === "dialogs" && event.value.length)).toEqual([]);
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(retained, "utf8")).toContain("保留会话");
			expect(await readFile(path.join(cwd, "input.txt"), "utf8")).toBe("input\n");
			expect(await readFile(path.join(agentDir, "settings.json"), "utf8")).toBe(settings);
			expect(host.snapshot().sessionId).toBe(id);
			expect(events.filter((event) => event.type === "sessions").at(-1)?.value.map((item) => item.path)).toEqual([retained]);
		});

		it("删除当前会话后进入同工作区的新会话，后续写入不会恢复已删除文件", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "switch", path: file });
			const id = host.snapshot().sessionId;
			await host.dispatch({ action: "deleteSession", path: file });
			expect(host.snapshot().sessionId).not.toBe(id);
			expect(host.snapshot().cwd).toBe(cwd);
			expect(host.snapshot().messages).toHaveLength(0);
			await host.dispatch(prompt);
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI SDK result\n");
		});

		it("未持久化的新会话也可删除", async () => {
			const { host } = context();
			const before = host.snapshot();
			if (!before.sessionFile) throw new Error("新会话缺少目标路径");
			await expect(readFile(before.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
			await host.dispatch({ action: "deleteSession", path: before.sessionFile });
			expect(host.snapshot().sessionId).not.toBe(before.sessionId);
			expect(host.snapshot().messages).toHaveLength(0);
		});

		it("拒绝任意项目文件和未列入共享索引的删除目标", async () => {
			const { host, cwd } = context();
			const file = path.join(cwd, "project.jsonl");
			await writeFile(file, '{"project":true}\n');
			await expect(host.dispatch({ action: "deleteSession", path: file })).rejects.toThrow("历史记录已不存在");
			expect(await readFile(file, "utf8")).toBe('{"project":true}\n');
		});

		it.each(["directory", "file"] as const)("拒绝通过 %s 符号链接删除共享目录外的历史", async (kind) => {
			const { host, cwd, agentDir } = context();
			const external = await storeSession({ cwd, agentDir: path.join(cwd, "external-agent"), provider: "gui-fixture" });
			const directory = path.join(agentDir, "sessions", "linked");
			let linked: string;
			if (kind === "directory") {
				await symlink(path.dirname(external), directory, "dir");
				linked = path.join(directory, path.basename(external));
			} else {
				await mkdir(directory);
				linked = path.join(directory, "linked.jsonl");
				await symlink(external, linked, "file");
			}
			await expect(host.dispatch({ action: "deleteSession", path: linked })).rejects.toThrow(/共享历史目录之外|符号链接/);
			expect(await readFile(external, "utf8")).toContain("历史回复");
		});

		it("批量删除准备期间任一会话被修改，整批都必须重新确认", async () => {
			const { cwd, agentDir } = context();
			const first = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			const second = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			const plan = await prepareSessionDeletion([first, second], null);
			SessionManager.open(second).appendSessionInfo("TUI 修改名称");
			await expect(plan.verify()).rejects.toThrow("会话已被修改");
			expect(await readFile(first, "utf8")).toContain("历史回复");
			expect(await readFile(second, "utf8")).toContain("TUI 修改名称");
		});

		it("扩展取消当前会话切换时不删除该会话", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "switch", path: file });
			await mkdir(path.join(agentDir, "extensions"), { recursive: true });
			await writeFile(path.join(agentDir, "extensions", "keep-session.ts"),
				`export default function (pi) { pi.on("session_before_switch", () => ({ cancel: true })); }`);
			await host.dispatch({ action: "reload" });
			await host.dispatch({ action: "deleteSession", path: file });
			expect(host.snapshot().sessionFile).toBe(file);
			expect(await readFile(file, "utf8")).toContain("历史回复");
		});

		it("任务运行和审批期间拒绝删除历史", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await writeFile(path.join(agentDir, "configs", "approval-gate.jsonc"), '{"tools":{"write":{"default_action":"ask"}}}');
			const task = host.dispatch(prompt);
			await expect.poll(() => host.dialogs.list().length).toBe(1);
			const dialog = host.dialogs.list()[0];
			if (!dialog) throw new Error("缺少工具审批");
			await expect(host.dispatch({ action: "deleteSession", path: file })).rejects.toThrow("请先停止");
			await host.dispatch({ action: "dialog", id: dialog.id, value: null });
			await task;
			expect(await readFile(file, "utf8")).toContain("历史回复");
		});
	});
}
