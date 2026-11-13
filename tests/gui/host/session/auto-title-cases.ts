import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import type { GuiDialog } from "../../../../src/gui/shared/protocol/state.ts";
import type { ModelRequest, ModelResponse } from "../../../cli/model-server.ts";
import { deferred } from "../../../helpers/async.ts";
import { storeSession } from "../../helpers/session-fixture.ts";
import { readSnapshot } from "../read-snapshot.ts";

export function autoTitleTests(context: () => {
	host: GuiClient; cwd: string; agentDir: string; requests: ModelRequest[];
	setReply(reply: () => ModelResponse | Promise<ModelResponse>): void;
}) {
	describe("GUI 手动自动标题", () => {
		it.each([false, true])("重命名历史会话，已加载=%s，不切换当前会话且忽略自动开关", async (loaded) => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "原标题" });
			if (loaded) {
				await host.dispatch({ action: "openSession", path: file });
				await host.dispatch({ action: "new" });
			}
			const current = host.selected;
			await host.dispatch({ action: "autoTitleSession", path: file });
			expect(host.selected).toBe(current);
			expect(SessionManager.open(file).getSessionName()).toBe("检查文件并写入结果");
			await host.dispatch({ action: "openSession", path: file });
			expect(readSnapshot(host).name).toBe("检查文件并写入结果");
			expect(readSnapshot(host).titleGeneration).toBe("complete");
		});

		it("工具对话取最近五条正文，使用切换后的模型且不修改对话", async () => {
			const { host, requests } = context();
			for (const text of ["第一轮", "第二轮", "第三轮"]) {
				await host.dispatch({ action: "prompt", text, images: [], files: [], behavior: "followUp" });
			}
			await host.dispatch({ action: "model", provider: "gui-fixture", id: "second" });
			const before = readSnapshot(host);
			await host.dispatch({ action: "autoTitleSession", path: host.selected?.file });
			expect(requests.at(-1)).toMatchObject({ model: "second", messages: [
				{ role: "system" },
				{ role: "user", content: "<transcript>\nAssistant:\nGUI completed\n\nUser:\n第二轮\n\nAssistant:\nGUI completed\n\nUser:\n第三轮\n\nAssistant:\nGUI completed\n</transcript>" },
			] });
			expect(readSnapshot(host)).toMatchObject({ name: "检查文件并写入结果", model: { id: "second" }, messages: before.messages });
		});

		it("导航回旧分支后按配置截取正文，不包含另一分支", async () => {
			const { host, agentDir, requests } = context();
			await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"max_messages":2}');
			await host.dispatch({ action: "reload" });
			await host.dispatch({ action: "prompt", text: "较早的请求", images: [], files: [], behavior: "followUp" });
			await host.dispatch({ action: "prompt", text: "分支前的请求", images: [], files: [], behavior: "followUp" });
			const leaf = host.runtime.session.sessionManager.getLeafId();
			if (!leaf) throw new Error("缺少分支节点");
			await host.dispatch({ action: "prompt", text: "另一分支的请求", images: [], files: [], behavior: "followUp" });
			await host.dispatch({ action: "navigate", entryId: leaf, summarize: false });
			const before = readSnapshot(host);
			await host.dispatch({ action: "autoTitleSession", path: host.selected?.file });
			expect(requests.at(-1)?.messages.at(-1)?.content).toBe("<transcript>\nUser:\n分支前的请求\n\nAssistant:\nGUI completed\n</transcript>");
			expect(readSnapshot(host).messages).toEqual(before.messages);
		});

		it("历史会话等待信任确认时不自动切换，主动打开确认后继续原命名请求", async () => {
			const { host, cwd, agentDir, setReply } = context();
			const other = path.join(cwd, "untrusted-project");
			const file = await storeSession({ cwd: other, agentDir, provider: "gui-fixture", name: "原标题" });
			const directory = path.join(other, ".pi", "extensions");
			const marker = path.join(other, "executed.txt");
			await mkdir(directory, { recursive: true });
			await writeFile(path.join(directory, "project.ts"),
				`import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(marker)}, 'executed'); }`);
			const settingsFile = path.join(agentDir, "settings.json");
			const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
			await writeFile(settingsFile, JSON.stringify({ ...settings, defaultProjectTrust: "ask" }));
			const answer = vi.fn(() => ({ text: "确认后的标题" }));
			setReply(answer);
			let visibleDialogs: GuiDialog[] = [];
			const unsubscribe = host.subscribe((event) => { if (event.type === "dialogs") visibleDialogs = event.value; });
			try {
				const current = host.selected;
				const pending = host.dispatch({ action: "autoTitleSession", path: file });
				await expect.poll(() => [...host.host.sessions.values()].find((session) => session.file === file)?.activity.state).toBe("waiting");
				expect(host.selected).toBe(current);
				expect(visibleDialogs).toEqual([]);
				expect(answer).not.toHaveBeenCalled();
				await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
				const opening = host.dispatch({ action: "openSession", path: file });
				await expect.poll(() => visibleDialogs[0]?.title).toBe(`信任项目：${other}`);
				expect(host.selected?.file).toBe(file);
				const dialog = visibleDialogs[0];
				if (!dialog) throw new Error("缺少项目信任确认");
				await host.dispatch({ action: "dialog", id: dialog.id, value: "仅本次信任" });
				await Promise.all([opening, pending]);
				expect(await readFile(marker, "utf8")).toBe("executed");
				expect(answer).toHaveBeenCalledTimes(1);
				expect(SessionManager.open(file).getSessionName()).toBe("确认后的标题");
				expect(readSnapshot(host)).toMatchObject({ name: "确认后的标题", titleGeneration: "complete" });
			} finally { unsubscribe(); }
		});

		it("重载后使用新配置，失败保留原标题并可重新生成", async () => {
			const { host, cwd, agentDir, setReply } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "原标题" });
			await host.dispatch({ action: "openSession", path: file });
			await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"model":"missing/model","max_messages":2}');
			await host.dispatch({ action: "reload" });
			await expect(host.dispatch({ action: "autoTitleSession", path: file })).rejects.toThrow("model is unavailable");
			expect(readSnapshot(host).name).toBe("原标题");
			expect(readSnapshot(host).titleGeneration).toBeUndefined();
			await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"max_messages":0}');
			await host.dispatch({ action: "reload" });
			await expect(host.dispatch({ action: "autoTitleSession", path: file })).rejects.toThrow("configuration is unavailable");
			expect(readSnapshot(host).name).toBe("原标题");
			await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
			await host.dispatch({ action: "reload" });
			setReply(() => ({ text: "重新生成的标题" }));
			await host.dispatch({ action: "autoTitleSession", path: file });
			expect(readSnapshot(host).name).toBe("重新生成的标题");
		});

		it("生成超时报告失败并保留原标题，之后仍可重新生成", async () => {
			const { host, cwd, agentDir, setReply } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "原标题" });
			await host.dispatch({ action: "openSession", path: file });
			const started = deferred<void>();
			const reply = deferred<ModelResponse>();
			setReply(() => { started.resolve(); return reply.promise; });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			// 原生 AbortSignal.timeout 不受假时钟控制。
			const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(new DOMException("Title request timed out", "TimeoutError")), ms);
				return controller.signal;
			});
			try {
				const result = host.dispatch({ action: "autoTitleSession", path: file }).catch((error: unknown) => error);
				await started.promise;
				await vi.advanceTimersByTimeAsync(30_000);
				expect(await result).toMatchObject({ name: "TimeoutError" });
				expect(readSnapshot(host).name).toBe("原标题");
				expect(readSnapshot(host).titleGeneration).toBeUndefined();
			} finally {
				timeout.mockRestore();
				vi.useRealTimers();
				reply.resolve({ text: "过期标题" });
			}
			setReply(() => ({ text: "重试标题" }));
			await host.dispatch({ action: "autoTitleSession", path: file });
			expect(readSnapshot(host).name).toBe("重试标题");
		});

		it("生成期间手动改名不会被结果覆盖，也不会阻塞当前会话", async () => {
			const { host, cwd, agentDir, setReply } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "原标题" });
			const reply = deferred<ModelResponse>();
			const answer = vi.fn(() => reply.promise);
			setReply(answer);
			const pending = host.dispatch({ action: "autoTitleSession", path: file });
			await expect.poll(() => answer.mock.calls.length).toBe(1);
			const target = [...host.host.sessions.values()].find((session) => session.file === file);
			await expect.poll(() => target?.activity.titleGeneration).toBe("generating");
			await host.dispatch({ action: "rename", name: "当前会话" });
			await host.dispatch({ action: "renameSession", path: file, name: "手动名称" });
			reply.resolve({ text: "过期标题" });
			await pending;
			expect(SessionManager.open(file).getSessionName()).toBe("手动名称");
			expect(readSnapshot(host).name).toBe("当前会话");
		});

		it("关闭宿主取消历史会话的在途命名", async () => {
			const { host, cwd, agentDir, setReply } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "原标题" });
			const reply = deferred<ModelResponse>();
			const answer = vi.fn(() => reply.promise);
			setReply(answer);
			const pending = host.dispatch({ action: "autoTitleSession", path: file });
			await expect.poll(() => answer.mock.calls.length).toBe(1);
			await host.host.dispose();
			await pending;
			reply.resolve({ text: "过期标题" });
			expect(SessionManager.open(file).getSessionName()).toBe("原标题");
		});
	});
}
