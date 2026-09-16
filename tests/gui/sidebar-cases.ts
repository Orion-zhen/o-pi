import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { locateTranscript } from "../../src/gui/ui/transcript-location.ts";
import { storeSession } from "./session-fixture.ts";

export function sidebarTests(context: () => { host: GuiHost; cwd: string; agentDir: string; events: GuiEvent[] }) {
	describe("工作区与自动会话信息", () => {
		it("浏览真实目录和目录链接，切换后仍重放启动目录，不返回普通文件", async () => {
			const { host, cwd, events } = context();
			const child = path.join(cwd, "子目录");
			await mkdir(child);
			await symlink(child, path.join(cwd, "链接"), "dir");
			await symlink(path.join(cwd, "missing"), path.join(cwd, "失效链接"));
			await host.dispatch({ action: "directories", path: cwd });
			const listing = events.filter((event) => event.type === "directories").at(-1)?.value;
			expect(listing).toMatchObject({ path: await realpath(cwd), parent: path.dirname(await realpath(cwd)) });
			expect(listing?.children.map((child) => child.name).sort()).toEqual(["子目录", "链接"].sort());
			await host.dispatch({ action: "workspace", path: child });
			const replay: GuiEvent[] = [];
			host.subscribe((event) => replay.push(event))();
			expect(replay.find((event) => event.type === "workspaceRoot")).toEqual({ type: "workspaceRoot", path: cwd });
			await expect(host.dispatch({ action: "directories", path: path.join(cwd, "input.txt") })).rejects.toMatchObject({ code: "ENOTDIR" });
			expect(host.snapshot().cwd).toBe(child);
		});

		it("移除失效工作区保留历史，重启后仍隐藏，重新选择目录恢复", async () => {
			const { host, cwd, agentDir, events } = context();
			const missing = path.join(cwd, "失效工作区");
			const file = await storeSession({ cwd: missing, agentDir, provider: "gui-fixture", name: "保留历史" });
			await rm(missing, { recursive: true });
			await host.dispatch({ action: "sessions" });
			expect(events.filter((event) => event.type === "workspaces").at(-1)?.value).toContainEqual({ path: missing, exists: false });
			await host.dispatch({ action: "removeWorkspace", path: missing });
			expect(events.filter((event) => event.type === "workspaces").at(-1)?.value).not.toContainEqual(expect.objectContaining({ path: missing }));
			expect(events.filter((event) => event.type === "sessions").at(-1)?.value).toContainEqual(expect.objectContaining({ path: file }));
			expect(await readFile(file, "utf8")).toContain("保留历史");
			await host.dispose();
			const restarted = new GuiHost();
			const replay: GuiEvent[] = [];
			restarted.subscribe((event) => replay.push(event));
			try {
				await restarted.start(cwd);
				await restarted.dispatch({ action: "sessions" });
				expect(replay.filter((event) => event.type === "workspaces").at(-1)?.value).not.toContainEqual(expect.objectContaining({ path: missing }));
				await expect(restarted.dispatch({ action: "workspace", path: missing })).rejects.toMatchObject({ code: "ENOENT" });
				await mkdir(missing);
				await restarted.dispatch({ action: "workspace", path: missing });
				await restarted.dispatch({ action: "sessions" });
				expect(replay.filter((event) => event.type === "workspaces").at(-1)?.value).toContainEqual({ path: missing, exists: true });
				await restarted.dispatch({ action: "switch", path: file });
				expect(restarted.snapshot().name).toBe("保留历史");
			} finally { await restarted.dispose(); }
		});

		it("工作区移除保护启动目录和当前目录，不删除磁盘文件", async () => {
			const { host, cwd, agentDir, events } = context();
			const other = path.join(cwd, "保留项目");
			await storeSession({ cwd: other, agentDir, provider: "gui-fixture" });
			const source = path.join(other, "source.ts");
			await writeFile(source, "project source\n");
			await expect(host.dispatch({ action: "removeWorkspace", path: cwd })).rejects.toThrow("不能移除");
			await host.dispatch({ action: "workspace", path: other });
			await expect(host.dispatch({ action: "removeWorkspace", path: other })).rejects.toThrow("不能移除");
			await expect(host.dispatch({ action: "removeWorkspace", path: cwd })).rejects.toThrow("不能移除");
			await host.dispatch({ action: "workspace", path: cwd });
			await host.dispatch({ action: "removeWorkspace", path: other });
			await host.dispatch({ action: "sessions" });
			expect(events.filter((event) => event.type === "workspaces").at(-1)?.value).toEqual([{ path: cwd, exists: true }]);
			expect(await readFile(source, "utf8")).toBe("project source\n");
			await expect(host.dispatch({ action: "removeWorkspace", path: path.join(cwd, "unknown") })).rejects.toThrow("不在列表");
			const replay: GuiEvent[] = [];
			host.subscribe((event) => replay.push(event))();
			expect(replay.find((event) => event.type === "workspaces")).toEqual({ type: "workspaces", value: [{ path: cwd, exists: true }] });
		});

		it("重命名未打开的历史不会切换会话，拒绝索引之外的文件", async () => {
			const { host, cwd, agentDir, events } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "待改名" });
			const before = host.snapshot();
			await host.dispatch({ action: "renameSession", path: file, name: "历史新名称" });
			expect(host.snapshot().sessionId).toBe(before.sessionId);
			expect(host.snapshot().messages).toEqual(before.messages);
			expect(events.filter((event) => event.type === "sessions").at(-1)?.value).toContainEqual(expect.objectContaining({ path: file, title: "历史新名称" }));
			await host.dispatch({ action: "switch", path: file });
			await host.dispatch({ action: "renameSession", path: file, name: "当前新名称" });
			expect(host.snapshot().name).toBe("当前新名称");
			const source = path.join(cwd, "source.jsonl");
			await writeFile(source, "project data\n");
			await expect(host.dispatch({ action: "renameSession", path: source, name: "不允许" })).rejects.toThrow("历史记录已不存在");
			expect(await readFile(source, "utf8")).toBe("project data\n");
			const external = await storeSession({ cwd, agentDir: path.join(cwd, "external-agent"), provider: "gui-fixture" });
			const linked = path.join(path.dirname(file), "linked.jsonl");
			await symlink(external, linked);
			await expect(host.dispatch({ action: "renameSession", path: linked, name: "不允许" })).rejects.toThrow("符号链接");
			expect(await readFile(external, "utf8")).not.toContain("不允许");
		});

		it("删除操作替换当前会话，文件边界检查仍生效", async () => {
			const { host, cwd, agentDir, events } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "switch", path: file });
			const id = host.snapshot().sessionId;
			const start = events.length;
			await host.dispatch({ action: "deleteSession", path: file });
			expect(events.slice(start).filter((event) => event.type === "dialogs" && event.value.length)).toEqual([]);
			expect(host.snapshot()).toMatchObject({ cwd, messages: [] });
			expect(host.snapshot().sessionId).not.toBe(id);
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(host.dispatch({ action: "deleteSession", path: path.join(cwd, "input.txt") })).rejects.toThrow("历史记录已不存在");
			expect(await readFile(path.join(cwd, "input.txt"), "utf8")).toBe("input\n");
		});

		it("会话信息读取无快照反馈，回复、标签、新建和重载后均返回最新数据", async () => {
			const { host, events } = context();
			const before = host.snapshot();
			const start = events.length;
			await host.dispatch({ action: "sessionInfo" });
			expect(events.slice(start).filter((event) => event.type === "snapshot")).toEqual([]);
			expect(events.slice(start).filter((event) => event.type === "sessionInfo")).toHaveLength(1);
			expect(host.snapshot()).toEqual(before);
			await host.dispatch({ action: "prompt", text: "执行工具", images: [], behavior: "followUp" });
			await host.dispatch({ action: "sessionInfo" });
			const info = events.filter((event) => event.type === "sessionInfo").at(-1)?.value;
			expect(info?.stats.session.userTurns).toBe(1);
			expect(info?.stats.tools.calls).toBe(2);
			expect(info?.telemetry.session_id).toBe(host.snapshot().sessionId);
			expect(info?.telemetry.pending_calls).toBe(0);
			const user = host.snapshot().entries.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!user) throw new Error("缺少用户消息");
			await host.dispatch({ action: "label", entryId: user.id, label: "定位标记" });
			await host.dispatch({ action: "sessionInfo" });
			expect(JSON.stringify(events.filter((event) => event.type === "sessionInfo").at(-1)?.value.tree)).toContain("定位标记");
			await host.dispatch({ action: "new" });
			await host.dispatch({ action: "reload" });
			await host.dispatch({ action: "sessionInfo" });
			const empty = events.filter((event) => event.type === "sessionInfo").at(-1)?.value;
			expect(empty).toMatchObject({ sessionId: host.snapshot().sessionId, tree: [], stats: { session: { userTurns: 0 }, tools: { calls: 0 } } });
		});

		it("压缩摘要可直接定位，已压缩的旧消息仍可只读预览", async () => {
			const { host } = context();
			await host.dispatch({ action: "prompt", text: "待压缩的旧消息", images: [], behavior: "followUp" });
			const before = host.snapshot();
			const user = before.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
			const answer = before.entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (!before.sessionFile || !user || !answer) throw new Error("缺少持久化消息");
			await host.dispatch({ action: "new" });
			const manager = SessionManager.open(before.sessionFile);
			const summary = manager.appendCompaction("压缩摘要", answer.id, 100);
			await host.dispatch({ action: "switch", path: before.sessionFile });
			const snapshot = host.snapshot();
			const current = locateTranscript(snapshot, summary);
			expect(current.preview).toBe(false);
			expect(current.entryIds).toContain(summary);
			const old = locateTranscript(snapshot, user.id);
			expect(old.preview).toBe(true);
			expect(old.entryIds).toContain(user.id);
			expect(JSON.stringify(old.source.messages)).toContain("待压缩的旧消息");
			expect(host.snapshot().leafId).toBe(summary);
		});

		it("聊天定位使用持久化条目 ID，旧分支只读预览而不改变活动分支", async () => {
			const { host } = context();
			await host.dispatch({ action: "prompt", text: "第一条分支", images: [], behavior: "followUp" });
			const snapshot = host.snapshot();
			const user = snapshot.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
			const answer = snapshot.entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (!user || !answer) throw new Error("缺少消息条目");
			const active = locateTranscript(snapshot, answer.id);
			expect(active.preview).toBe(false);
			expect(active.entryIds).toContain(user.id);
			expect(active.entryIds).toContain(answer.id);
			await host.dispatch({ action: "navigate", entryId: user.id, summarize: false });
			await host.dispatch({ action: "prompt", text: "另一条分支", images: [], behavior: "followUp" });
			const current = host.snapshot();
			const preview = locateTranscript(current, answer.id);
			expect(preview.preview).toBe(true);
			expect(preview.entryIds).toContain(answer.id);
			expect(JSON.stringify(preview.source.messages)).toContain("第一条分支");
			expect(JSON.stringify(preview.source.messages)).not.toContain("另一条分支");
			expect(host.snapshot().leafId).toBe(current.leafId);
			expect(locateTranscript(current, undefined).source.messages).toEqual(current.messages);
		});
	});
}
