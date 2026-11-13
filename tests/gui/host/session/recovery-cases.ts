import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import type { GuiEvent } from "../../../../src/gui/shared/protocol/events.ts";
import { storeSession } from "../../helpers/session-fixture.ts";
import { readSnapshot } from "../read-snapshot.ts";

export function recoveryTests(context: () => { host: GuiClient; cwd: string; agentDir: string; events: GuiEvent[] }) {
	describe("失效工作区与会话恢复", () => {
		it("进入失效工作区并切换历史，允许重命名但阻止新消息，不重建目录", async () => {
			const { host, cwd, agentDir } = context();
			const missing = path.join(cwd, "missing-workspace");
			const first = await storeSession({ cwd: missing, agentDir, provider: "gui-fixture", name: "待恢复一" });
			const second = await storeSession({ cwd: missing, agentDir, provider: "gui-fixture", name: "待恢复二" });
			await rm(missing, { recursive: true });
			await host.dispatch({ action: "workspace", path: missing });
			expect(readSnapshot(host).cwd).toBe(missing);
			expect([first, second]).toContain(host.selected?.file);
			await host.dispatch({ action: "openSession", path: first });
			await host.dispatch({ action: "rename", name: "重命名仍可用" });
			expect(readSnapshot(host).name).toBe("重命名仍可用");
			const before = await readFile(first, "utf8");
			await expect(host.dispatch({ action: "prompt", text: "不能发送", images: [], behavior: "followUp" })).rejects.toThrow("无法发送消息");
			expect(await readFile(first, "utf8")).toBe(before);
			await host.dispatch({ action: "openSession", path: second });
			expect(readSnapshot(host).name).toBe("待恢复二");
			await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("复制完整会话后保留原文件和当前选择，副本可继续发送消息", async () => {
			const { host, cwd, agentDir, events } = context();
			const missing = path.join(cwd, "missing-workspace");
			const file = await storeSession({ cwd: missing, agentDir, provider: "gui-fixture", name: "待恢复" });
			await rm(missing, { recursive: true });
			await host.dispatch({ action: "openSession", path: file });
			const sourceId = readSnapshot(host).sessionId;
			const original = await readFile(file, "utf8");
			const entries = SessionManager.open(file).getEntries();
			await host.dispatch({ action: "restoreSession", path: cwd });
			expect(readSnapshot(host)).toMatchObject({ sessionId: sourceId, cwd: missing });
			expect(await readFile(file, "utf8")).toBe(original);
			await host.dispatch({ action: "sessions", all: true });
			const recovered = events.findLast((event) => event.type === "sessions")?.value.find((session) => session.cwd === cwd && session.title === "待恢复");
			if (!recovered) throw new Error("复制后的会话未出现在目标工作区");
			const manager = SessionManager.open(recovered.path);
			expect(manager.getSessionId()).not.toBe(sourceId);
			expect(manager.getHeader()).toMatchObject({ cwd, parentSession: file });
			expect(manager.getEntries()).toEqual(entries);
			await host.dispatch({ action: "openSession", path: recovered.path });
			await host.dispatch({ action: "prompt", text: "继续读取并写入文件", images: [], behavior: "followUp" });
			expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI SDK result\n");
			expect(await readFile(file, "utf8")).toBe(original);
			await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("失效工作区删除当前会话后仍可切换到其他历史", async () => {
			const { host, cwd, agentDir } = context();
			const missing = path.join(cwd, "missing-workspace");
			const first = await storeSession({ cwd: missing, agentDir, provider: "gui-fixture", name: "删除此会话" });
			const second = await storeSession({ cwd: missing, agentDir, provider: "gui-fixture", name: "保留此会话" });
			await rm(missing, { recursive: true });
			await host.dispatch({ action: "openSession", path: first });
			await host.dispatch({ action: "deleteSession", path: first });
			expect(readSnapshot(host).cwd).toBe(missing);
			expect(host.selected?.file).not.toBe(first);
			await host.dispatch({ action: "openSession", path: second });
			expect(readSnapshot(host).name).toBe("保留此会话");
			await expect(readFile(first)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("目标目录在选择后被删除时，复制失败且保留原会话", async () => {
			const { host, cwd, agentDir } = context();
			const missing = path.join(cwd, "missing-workspace");
			const file = await storeSession({ cwd: missing, agentDir, provider: "gui-fixture" });
			await rm(missing, { recursive: true });
			await host.dispatch({ action: "openSession", path: file });
			const sourceId = readSnapshot(host).sessionId;
			const original = await readFile(file, "utf8");
			const target = path.join(cwd, "removed-target");
			await mkdir(target);
			await rm(target, { recursive: true });
			await expect(host.dispatch({ action: "restoreSession", path: target })).rejects.toMatchObject({ code: "ENOENT" });
			expect(readSnapshot(host).sessionId).toBe(sourceId);
			expect(await readFile(file, "utf8")).toBe(original);
			await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
}
