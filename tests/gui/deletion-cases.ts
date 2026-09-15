import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiAction, GuiEvent } from "../../src/gui/contract.ts";
import { storeSession } from "./session-fixture.ts";

type DeleteAction = Extract<GuiAction, { action: "deleteSession" | "deleteWorkspace" }>;
async function beginDelete(host: GuiHost, action: DeleteAction) {
	const result = host.dispatch(action).then(
		() => undefined,
		(error: unknown) => error,
	);
	await expect.poll(() => host.dialogs.list()[0]?.kind).toBe("confirm");
	const dialog = host.dialogs.list()[0];
	if (!dialog) throw new Error("缺少删除确认");
	return { result, dialog };
}
async function confirmDelete(host: GuiHost, action: DeleteAction) {
	const { result, dialog } = await beginDelete(host, action);
	await host.dispatch({ action: "dialog", id: dialog.id, value: "yes" });
	expect(await result).toBeUndefined();
}
const prompt = { action: "prompt", text: "读取并写入文件", images: [], behavior: "followUp" };

export function historyDeletionTests(
	context: () => { host: GuiHost; cwd: string; agentDir: string; events: GuiEvent[] },
) {
	describe("GUI 历史删除", () => {
		it("确认后删除共享会话文件，不删除项目文件", async () => {
			const { host, cwd, agentDir, events } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "待删除会话" });
			const retained = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "保留会话" });
			const originalSettings = await readFile(path.join(agentDir, "settings.json"), "utf8");
			const id = host.snapshot().sessionId;
			const { result, dialog } = await beginDelete(host, { action: "deleteSession", path: file });
			expect(dialog.message).toContain("待删除会话");
			expect(dialog.message).toContain("1 个共享历史会话");
			await host.dispatch({ action: "dialog", id: dialog.id, value: "yes" });
			expect(await result).toBeUndefined();
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(retained, "utf8")).toContain("保留会话");
			expect(await readFile(path.join(cwd, "input.txt"), "utf8")).toBe("input\n");
			expect(await readFile(path.join(agentDir, "settings.json"), "utf8")).toBe(originalSettings);
			expect(host.snapshot().sessionId).toBe(id);
			expect(
				events
					.filter((event) => event.type === "sessions")
					.at(-1)
					?.value.map((item) => item.path),
			).toEqual([retained]);
		});

		it("取消确认保留历史，等待确认时拒绝其他修改操作", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			const original = await readFile(file, "utf8");
			const { result, dialog } = await beginDelete(host, { action: "deleteWorkspace", cwd });
			await expect(host.dispatch({ action: "new" })).rejects.toThrow("请稍后再试");
			await host.dispatch({ action: "dialog", id: dialog.id, value: null });
			expect(await result).toBeUndefined();
			expect(await readFile(file, "utf8")).toBe(original);
			expect(host.snapshot().cwd).toBe(cwd);
		});

		it("删除当前会话后进入同工作区的新会话，后续写入不会恢复已删除文件", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "switch", path: file });
			const id = host.snapshot().sessionId;
			await confirmDelete(host, { action: "deleteSession", path: file });
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
			await confirmDelete(host, { action: "deleteSession", path: before.sessionFile });
			expect(host.snapshot().sessionId).not.toBe(before.sessionId);
			expect(host.snapshot().messages).toHaveLength(0);
		});

		it("按完整工作目录批量删除，即使同名工作区的文件混存也不误删", async () => {
			const { host, cwd, agentDir } = context();
			const project = path.join(cwd, "a", "project");
			const other = path.join(cwd, "b", "project");
			const options = { cwd: project, agentDir, provider: "gui-fixture" };
			const first = await storeSession(options);
			const second = await storeSession(options);
			const retained = await storeSession({ ...options, cwd: other });
			expect(path.dirname(retained)).toBe(path.dirname(first));
			const source = path.join(project, "source.ts");
			await writeFile(source, "export const value = 1;\n");
			const { result, dialog } = await beginDelete(host, { action: "deleteWorkspace", cwd: project });
			expect(dialog.message).toContain(project);
			expect(dialog.message).toContain("2 个共享历史会话");
			await host.dispatch({ action: "dialog", id: dialog.id, value: "yes" });
			expect(await result).toBeUndefined();
			await expect(readFile(first)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(second)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(retained, "utf8")).toContain(other);
			expect(await readFile(source, "utf8")).toBe("export const value = 1;\n");
			expect(host.snapshot().cwd).toBe(cwd);
		});

		it("删除当前工作区后重连仍未选择工作区，可打开目录重新开始", async () => {
			const { host, cwd, agentDir, events } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "switch", path: file });
			await confirmDelete(host, { action: "deleteWorkspace", cwd });
			expect(events.filter((event) => event.type === "snapshot").at(-1)?.value).toBeNull();
			expect(events.filter((event) => event.type === "sessions").at(-1)?.value).toEqual([]);
			const replay: GuiEvent[] = [];
			const unsubscribe = host.subscribe((event) => replay.push(event));
			expect(replay.find((event) => event.type === "snapshot")?.value).toBeNull();
			unsubscribe();
			await expect(host.dispatch(prompt)).rejects.toThrow("请先选择工作区");
			await host.dispatch({ action: "workspace", path: cwd });
			expect(host.snapshot().cwd).toBe(cwd);
			expect(host.snapshot().messages).toHaveLength(0);
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("未选择工作区时可恢复其他历史，也可继续删除其他工作区", async () => {
			const { host, cwd, agentDir } = context();
			const first = await storeSession({
				cwd: path.join(cwd, "other"),
				agentDir,
				provider: "gui-fixture",
				name: "恢复目标",
			});
			const removed = await storeSession({ cwd: path.join(cwd, "removed"), agentDir, provider: "gui-fixture" });
			await confirmDelete(host, { action: "deleteWorkspace", cwd });
			await confirmDelete(host, { action: "deleteWorkspace", cwd: path.join(cwd, "removed") });
			await expect(readFile(removed)).rejects.toMatchObject({ code: "ENOENT" });
			await host.dispatch({ action: "switch", path: first });
			expect(host.snapshot()).toMatchObject({ cwd: path.join(cwd, "other"), sessionFile: first, name: "恢复目标" });
			expect(JSON.stringify(host.snapshot().messages)).toContain("历史回复");
		});

		it("拒绝任意项目文件和未列入共享索引的删除目标", async () => {
			const { host, cwd } = context();
			const file = path.join(cwd, "project.jsonl");
			await writeFile(file, '{"project":true}\n');
			await expect(host.dispatch({ action: "deleteSession", path: file })).rejects.toThrow("历史记录已不存在");
			await expect(host.dispatch({ action: "deleteWorkspace", cwd: path.dirname(cwd) })).rejects.toThrow(
				"历史记录已不存在",
			);
			expect(await readFile(file, "utf8")).toBe('{"project":true}\n');
			expect(host.dialogs.list()).toEqual([]);
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
			await expect(host.dispatch({ action: "deleteSession", path: linked })).rejects.toThrow(
				/共享历史目录之外|符号链接/,
			);
			expect(await readFile(external, "utf8")).toContain("历史回复");
			expect(host.dialogs.list()).toEqual([]);
		});

		it("确认期间会话被 TUI 修改时拒绝删除，不退出当前会话", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "switch", path: file });
			const id = host.snapshot().sessionId;
			const { result, dialog } = await beginDelete(host, { action: "deleteSession", path: file });
			SessionManager.open(file).appendSessionInfo("TUI 修改名称");
			await host.dispatch({ action: "dialog", id: dialog.id, value: "yes" });
			expect(await result).toMatchObject({ message: "会话已被修改，请重新确认删除。" });
			expect(await readFile(file, "utf8")).toContain("TUI 修改名称");
			expect(host.snapshot().sessionId).toBe(id);
		});

		it("确认期间工作区新增会话时重新确认，不删除未确认的新历史", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			const { result, dialog } = await beginDelete(host, { action: "deleteWorkspace", cwd });
			const added = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "dialog", id: dialog.id, value: "yes" });
			expect(await result).toMatchObject({ message: "历史记录已变更，请重新确认删除。" });
			expect(await readFile(file, "utf8")).toContain("历史回复");
			expect(await readFile(added, "utf8")).toContain("历史回复");
		});

		it("扩展取消当前会话切换时不删除该会话", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await host.dispatch({ action: "switch", path: file });
			await mkdir(path.join(agentDir, "extensions"), { recursive: true });
			await writeFile(
				path.join(agentDir, "extensions", "keep-session.ts"),
				`export default function (pi) { pi.on("session_before_switch", () => ({ cancel: true })); }`,
			);
			await host.dispatch({ action: "reload" });
			await confirmDelete(host, { action: "deleteSession", path: file });
			expect(host.snapshot().sessionFile).toBe(file);
			expect(await readFile(file, "utf8")).toContain("历史回复");
		});

		it("任务运行和审批期间拒绝删除历史", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture" });
			await writeFile(
				path.join(agentDir, "configs", "approval-gate.jsonc"),
				'{"tools":{"write":{"default_action":"ask"}}}',
			);
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
