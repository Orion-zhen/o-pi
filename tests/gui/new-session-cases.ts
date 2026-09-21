import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GuiClient } from "../../src/gui/host/client.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { sessionList } from "../../src/gui/ui/session-list.ts";
import { storeSession } from "./session-fixture.ts";

const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });

export function newSessionTests(context: () => { host: GuiClient; cwd: string; agentDir: string }) {
	const rows = (host: GuiClient) => {
		const events: GuiEvent[] = [];
		host.replay((event) => events.push(event));
		const activity = events.find((event) => event.type === "activity")?.value ?? [];
		const history = events.find((event) => event.type === "sessions")?.value ?? [];
		return sessionList(history, activity.map((item) => ({ ...item, unread: false })), host.selected?.id ?? null);
	};
	describe("待发送会话", () => {
		it("手动加载技能后新建清除上下文和运行状态，保留未发送草稿", async () => {
			const { host, agentDir } = context();
			const skillDir = path.join(agentDir, "skills", "oops");
			await mkdir(skillDir, { recursive: true });
			await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: oops\ndescription: Test skill\n---\nUNIQUE_SKILL_BODY\n");
			await host.dispatch(prompt("/reload"));
			await host.dispatch(prompt("/skill:oops"));
			const previous = host.selected;
			expect(previous?.pending).toBe(true);
			expect(JSON.stringify(host.snapshot().messages)).toContain("UNIQUE_SKILL_BODY");
			await host.dispatch({ action: "draft", text: "尚未发送" });
			const events: GuiEvent[] = [];
			const unsubscribe = host.subscribe((event) => events.push(event));
			try { await host.dispatch({ action: "new" }); }
			finally { unsubscribe(); }
			expect(host.selected).not.toBe(previous);
			expect(host.selected?.pending).toBe(true);
			expect(host.snapshot().messages).toEqual([]);
			expect(host.runtime.session.sessionManager.getBranch().some((entry) => JSON.stringify(entry).includes("oops"))).toBe(false);
			expect(host.readDraft(host.snapshot().sessionId)).toBe("尚未发送");
			expect(events).toContainEqual(expect.objectContaining({ type: "selected", draftFrom: previous?.id }));
			expect(host.host.sessions.size).toBe(1);
		});
		it("并发新建一万次只重置一次，不增加列表项或文件", async () => {
			const { host } = context();
			const initial = host.selected;
			const runtime = host.runtime;
			await Promise.all(Array.from({ length: 10_000 }, () => host.dispatch({ action: "new" })));
			await host.dispatch({ action: "sessions" });
			expect(host.selected).not.toBe(initial);
			expect(host.runtime).not.toBe(runtime);
			expect(host.host.sessions.size).toBe(1);
			expect(rows(host)).toEqual([]);
			const file = host.snapshot().sessionFile;
			if (!file) throw new Error("缺少待发送会话路径");
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("草稿、模型选择和界面命令不转为正式会话", async () => {
			const { host } = context();
			const id = host.snapshot().sessionId;
			await host.dispatch({ action: "draft", text: "尚未发送" });
			await host.dispatch({ action: "model", provider: "gui-fixture", id: "second" });
			await host.dispatch(prompt("/model"));
			await host.dispatch(prompt("/new"));
			expect(host.snapshot().sessionId).not.toBe(id);
			expect(host.readDraft(host.snapshot().sessionId)).toBe("尚未发送");
			expect(host.snapshot().model?.id).toBe("second");
			expect(rows(host)).toEqual([]);
		});

		it("从历史返回新建时重置待发送会话并保留已选模型", async () => {
			const { host, cwd, agentDir } = context();
			const pending = host.selected;
			await host.dispatch({ action: "model", provider: "gui-fixture", id: "second" });
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "已有历史" });
			await host.dispatch({ action: "openSession", path: file });
			await host.dispatch({ action: "new" });
			expect(host.selected).not.toBe(pending);
			expect(host.snapshot().model?.id).toBe("second");
			expect(host.host.sessions.size).toBe(2);
		});

		it("切换工作区后新建分别重置各自的待发送会话", async () => {
			const { host, cwd } = context();
			const first = host.selected;
			const other = path.join(cwd, "other-workspace");
			await mkdir(other);
			await host.dispatch({ action: "workspace", path: other });
			const second = host.selected;
			await host.dispatch({ action: "new" });
			expect(host.selected).not.toBe(second);
			const resetSecond = host.selected;
			await host.dispatch({ action: "workspace", path: cwd });
			await host.dispatch({ action: "new" });
			expect(host.selected).not.toBe(first);
			await host.dispatch({ action: "workspace", path: other });
			expect(host.selected).toBe(resetSecond);
			expect(host.host.sessions.size).toBe(2);
			expect(rows(host)).toEqual([]);
		});

		it("不同客户端从正式会话新建时不共享待发送配置", async () => {
			const { host } = context();
			await host.dispatch(prompt("!printf original"));
			const id = host.snapshot().sessionId;
			const second = host.host.createClient(id);
			try {
				await second.dispatch({ action: "openSession", id });
				await Promise.all([host.dispatch({ action: "new" }), second.dispatch({ action: "new" })]);
				expect(host.selected).not.toBe(second.selected);
				await host.dispatch({ action: "model", provider: "gui-fixture", id: "second" });
				expect(second.snapshot().model?.id).toBe("test");
				await Promise.all([host.dispatch({ action: "new" }), second.dispatch({ action: "new" })]);
				expect(host.host.sessions.size).toBe(3);
				expect(rows(host)).toHaveLength(1);
			} finally { second.close(); }
		});

		it("首条消息进入列表，从正式会话并发新建只准备一个空白页", async () => {
			const { host } = context();
			const id = host.snapshot().sessionId;
			await host.dispatch(prompt("第一条真实消息"));
			await host.dispatch({ action: "sessions" });
			expect(rows(host)).toHaveLength(1);
			expect(rows(host)[0]?.target).toEqual({ id });
			await Promise.all(Array.from({ length: 100 }, () => host.dispatch({ action: "new" }, id)));
			const pending = host.selected;
			expect(pending?.id).not.toBe(id);
			expect(pending?.pending).toBe(true);
			expect(host.host.sessions.size).toBe(2);
			expect(rows(host)).toHaveLength(1);
			await host.dispatch({ action: "openSession", id });
			await host.dispatch({ action: "new" });
			expect(host.selected).not.toBe(pending);
			await host.dispatch(prompt("!printf shell-message"));
			expect(rows(host)).toHaveLength(2);
			await host.dispatch({ action: "new" });
			expect(host.host.sessions.size).toBe(3);
			expect(rows(host)).toHaveLength(2);
		});
	});
}
