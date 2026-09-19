import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiClient } from "../../src/gui/host/client.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { storeSession } from "./session-fixture.ts";

const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });

export function multiSessionTests(context: () => { host: GuiClient; cwd: string; agentDir: string }) {
	describe("多会话执行与客户端隔离", () => {
		afterEach(() => { vi.useRealTimers(); });

		it("A 等待审批时 B 可完成 Shell，切回只显示 A 的审批并消费一次", async () => {
			const { host: first, agentDir } = context();
			await writeFile(path.join(agentDir, "configs", "approval-gate.jsonc"), '{"tools":{"write":{"default_action":"ask"}}}');
			const original = first.snapshot().sessionId;
			const task = first.dispatch(prompt("任务 A"));
			await expect.poll(() => first.dialogs.list().length).toBe(1);
			const approval = first.dialogs.list()[0];
			if (!approval) throw new Error("缺少审批");
			const second = first.host.createClient();
			const events: GuiEvent[] = [];
			second.subscribe((event) => events.push(event));
			try {
				await second.dispatch({ action: "new" });
				expect(first.snapshot().sessionId).toBe(original);
				expect(second.dialogs.list()).toEqual([]);
				await second.dispatch(prompt("!printf independent-B"));
				expect(JSON.stringify(second.snapshot().messages)).toContain("independent-B");
				expect(JSON.stringify(first.snapshot().messages)).not.toContain("independent-B");
				expect(first.dialogs.list()[0]?.id).toBe(approval.id);
				await second.dispatch({ action: "selectSession", id: original });
				expect(second.runtime).toBe(first.runtime);
				expect(second.dialogs.list()[0]?.id).toBe(approval.id);
				await second.dispatch({ action: "dialog", id: approval.id, value: "Allow once" });
				await task;
				await expect(first.dispatch({ action: "dialog", id: approval.id, value: "Allow once" })).rejects.toThrow("已结束");
				await expect.poll(() => events.filter((event) => event.type === "activity").at(-1)?.value.find((item) => item.sessionId === original))
					.toMatchObject({ state: "idle", completedAt: expect.any(Number) });
			} finally { await first.dispatch({ action: "abort" }, original); await task; second.close(); }
		});

		it("停止 B 不取消后台 A，停止后旧审批不能恢复任务", async () => {
			const { host, agentDir } = context();
			await writeFile(path.join(agentDir, "configs", "approval-gate.jsonc"), '{"tools":{"write":{"default_action":"ask"}}}');
			const a = host.snapshot().sessionId;
			const first = host.dispatch(prompt("等待批准的 A"));
			await expect.poll(() => host.dialogs.list().length).toBe(1);
			const approval = host.dialogs.list()[0];
			if (!approval) throw new Error("缺少审批");
			await host.dispatch({ action: "new" });
			const b = host.snapshot().sessionId;
			const second = host.dispatch(prompt("!printf running-B; sleep 30"));
			try {
				await expect.poll(() => host.snapshot().status["bash"]).toContain("running-B");
				await host.dispatch({ action: "abort" }, b);
				await second;
				await host.dispatch({ action: "selectSession", id: a });
				expect(host.dialogs.list()[0]?.id).toBe(approval.id);
				await host.dispatch({ action: "abort" }, a);
				await first;
				await expect(host.dispatch({ action: "dialog", id: approval.id, value: "Allow once" }, a)).rejects.toThrow("已结束");
			} finally { await host.dispatch({ action: "abort" }, a); await host.dispatch({ action: "abort" }, b); await Promise.all([first, second]); }
		});

		it("并发打开同一历史只创建一个运行实例，界面命令不广播到其他页面", async () => {
			const { host, cwd, agentDir } = context();
			const file = await storeSession({ cwd, agentDir, provider: "gui-fixture", name: "共同查看" });
			const second = host.host.createClient();
			const events: GuiEvent[] = [];
			second.subscribe((event) => events.push(event));
			try {
				await Promise.all([host.dispatch({ action: "switch", path: file }), second.dispatch({ action: "switch", path: file })]);
				expect(host.runtime).toBe(second.runtime);
				await host.dispatch({ action: "view", view: "system" });
				expect(events.some((event) => event.type === "panel")).toBe(false);
				await host.dispatch({ action: "new" });
				expect(second.snapshot().sessionFile).toBe(file);
			} finally { second.close(); }
		});

		it("创建分支不替换另一页面仍在查看的父会话", async () => {
			const { host } = context();
			await host.dispatch(prompt("父会话"));
			const snapshot = host.snapshot();
			const user = snapshot.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!user) throw new Error("缺少分支起点");
			const second = host.host.createClient(snapshot.sessionId);
			try {
				await second.dispatch({ action: "selectSession", id: snapshot.sessionId });
				await host.dispatch({ action: "fork", entryId: user.id });
				expect(host.snapshot().sessionId).not.toBe(snapshot.sessionId);
				expect(second.snapshot().sessionId).toBe(snapshot.sessionId);
				expect(second.snapshot().messages).toEqual(snapshot.messages);
			} finally { second.close(); }
		});

		it("后台缓存的会话文件被删除后不能创建替代会话", async () => {
			const { host } = context();
			await host.dispatch(prompt("保存待删除历史"));
			const original = host.snapshot();
			if (!original.sessionFile) throw new Error("缺少会话文件");
			await host.dispatch({ action: "new" });
			const current = host.snapshot().sessionId;
			await rm(original.sessionFile);
			await expect(host.dispatch({ action: "selectSession", id: original.sessionId })).rejects.toMatchObject({ code: "ENOENT" });
			expect(host.snapshot().sessionId).toBe(current);
			await expect(readFile(original.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("未超时实例全部保留，超时实例按 LRU 最多保留三个且不受未超时实例挤占", async () => {
			const { host } = context();
			vi.useFakeTimers({ toFake: ["Date"] });
			const cached: { id: string; instance: GuiClient["session"] }[] = [];
			for (let index = 0; index < 5; index++) {
				cached.push({ id: host.snapshot().sessionId, instance: host.session });
				await host.dispatch({ action: "new" });
				vi.setSystemTime(Date.now() + 1_000);
			}
			await host.host.collect();
			for (const item of cached) expect(host.host.slots.get(item.id)?.instance).toBe(item.instance);
			vi.setSystemTime(Date.now() + 60_000);
			const recent = { id: host.snapshot().sessionId, instance: host.session };
			await host.dispatch({ action: "new" });
			const current = host.runtime;
			await host.host.collect();
			for (const [index, item] of cached.entries())
				expect(host.host.slots.get(item.id)?.instance).toBe(index < 2 ? undefined : item.instance);
			expect(host.host.slots.get(recent.id)?.instance).toBe(recent.instance);
			expect(host.runtime).toBe(current);
		});

		it("超时实例未超过保留额度时，多次扫描仍不释放", async () => {
			const { host } = context();
			vi.useFakeTimers({ toFake: ["Date"] });
			const a = { id: host.snapshot().sessionId, instance: host.session };
			await host.dispatch({ action: "new" });
			const b = { id: host.snapshot().sessionId, instance: host.session };
			await host.dispatch({ action: "new" });
			for (const elapsed of [60_000, 600_000]) {
				vi.setSystemTime(Date.now() + elapsed);
				await host.host.collect();
				expect(host.host.slots.get(a.id)?.instance).toBe(a.instance);
				expect(host.host.slots.get(b.id)?.instance).toBe(b.instance);
			}
		});

		it("保留额度为零仍须等待超时，隐藏页面回收后恢复同一空白会话", async () => {
			const { cwd, agentDir } = context();
			await writeFile(path.join(agentDir, "configs", "gui.jsonc"), '{"sessionCache":{"idleLimit":0}}');
			const service = new GuiHost();
			const client = service.createClient();
			try {
				await service.start(cwd);
				vi.useFakeTimers({ toFake: ["Date"] });
				const id = client.snapshot().sessionId;
				const original = client.runtime;
				const events: GuiEvent[] = [];
				client.subscribe((event) => events.push(event));
				await client.dispatch({ action: "observe", visible: false });
				events.length = 0;
				vi.setSystemTime(Date.now() + 59_999);
				await service.collect();
				expect(client.runtime).toBe(original);
				vi.setSystemTime(Date.now() + 1);
				await service.collect();
				expect(events.some((event) => event.type === "snapshot")).toBe(false);
				await client.dispatch({ action: "observe", visible: true });
				expect(client.snapshot().sessionId).toBe(id);
				expect(client.runtime).not.toBe(original);
				expect(client.snapshot().messages).toEqual([]);
			} finally { await service.dispose(); }
		});

		it("保存缓存数量后按最近使用回收，删除覆盖后恢复默认策略", async () => {
			const { host } = context();
			vi.useFakeTimers({ toFake: ["Date"] });
			const a = { id: host.snapshot().sessionId, runtime: host.runtime };
			await host.dispatch({ action: "new" });
			vi.setSystemTime(Date.now() + 1_000);
			const b = { id: host.snapshot().sessionId, runtime: host.runtime };
			await host.dispatch({ action: "new" });
			const current = host.runtime;
			const content = '{"sessionCache":{"idleLimit":1}}';
			await host.dispatch({ action: "saveGuiConfig", original: "", content });
			vi.setSystemTime(Date.now() + 60_000);
			await host.host.collect();
			expect(host.runtime).toBe(current);
			await host.dispatch({ action: "selectSession", id: b.id });
			expect(host.runtime).toBe(b.runtime);
			await host.dispatch({ action: "selectSession", id: a.id });
			expect(host.runtime).not.toBe(a.runtime);
			const restored = host.runtime;
			await host.dispatch({ action: "saveGuiConfig", original: content, content: "{}" });
			await host.dispatch({ action: "new" });
			vi.setSystemTime(Date.now() + 60_000);
			await host.host.collect();
			await host.dispatch({ action: "selectSession", id: a.id });
			expect(host.runtime).toBe(restored);
		});

		it("缩短过期时长会重设已有扫描计时器，隐藏的空闲实例自动回收", async () => {
			const { host } = context();
			const slot = host.selected;
			if (!slot) throw new Error("缺少会话");
			const original = host.runtime;
			await host.dispatch({ action: "observe", visible: false });
			await host.dispatch({ action: "saveGuiConfig", original: "", content: '{"sessionCache":{"idleLimit":0,"idleMs":25}}' });
			await expect.poll(() => slot.instance, { timeout: 3_000 }).toBeUndefined();
			await host.dispatch({ action: "observe", visible: true });
			expect(host.snapshot().sessionId).toBe(slot.id);
			expect(host.runtime).not.toBe(original);
		});

		it("非法配置不阻止启动，在覆盖路径内修复后立即启用回收", async () => {
			const { cwd, agentDir } = context();
			process.env.PI_GUI_CONFIG = path.join(agentDir, "custom-gui.jsonc");
			const invalid = '{"sessionCache":{"idleMs":0}}';
			await writeFile(process.env.PI_GUI_CONFIG, invalid);
			const service = new GuiHost();
			const client = service.createClient();
			try {
				await service.start(cwd);
				vi.useFakeTimers({ toFake: ["Date"] });
				const original = client.runtime;
				const id = client.snapshot().sessionId;
				expect(await client.query({ query: "guiConfig" })).toMatchObject({ path: process.env.PI_GUI_CONFIG, state: "error" });
				await client.dispatch({ action: "observe", visible: false });
				vi.setSystemTime(Date.now() + 60_000);
				await service.collect();
				await client.dispatch({ action: "observe", visible: true });
				expect(client.runtime).toBe(original);
				await client.dispatch({ action: "saveGuiConfig", original: invalid, content: '{"sessionCache":{"idleLimit":0}}' });
				await client.dispatch({ action: "observe", visible: false });
				vi.setSystemTime(Date.now() + 60_000);
				await service.collect();
				await client.dispatch({ action: "observe", visible: true });
				expect(client.snapshot().sessionId).toBe(id);
				expect(client.runtime).not.toBe(original);
			} finally { await service.dispose(); }
		});

		it("回收空闲实例后恢复历史和会话授权，等待审批的实例不回收", async () => {
			const { cwd, agentDir } = context();
			await writeFile(path.join(agentDir, "configs", "approval-gate.jsonc"), '{"tools":{"write":{"default_action":"ask"}}}');
			await writeFile(path.join(agentDir, "configs", "gui.jsonc"), '{"sessionCache":{"idleLimit":0}}');
			const service = new GuiHost();
			const client = service.createClient();
			try {
				await service.start(cwd);
				vi.useFakeTimers({ toFake: ["Date"] });
				const a = client.snapshot().sessionId;
				const original = client.runtime;
				const task = client.dispatch(prompt("首次写入"));
				await expect.poll(() => client.dialogs.list().length).toBe(1);
				const approval = client.dialogs.list()[0];
				if (!approval) throw new Error("缺少审批");
				await client.dispatch({ action: "new" });
				vi.setSystemTime(Date.now() + 60_000);
				await service.collect();
				await client.dispatch({ action: "selectSession", id: a });
				expect(client.runtime).toBe(original);
				await client.dispatch({ action: "dialog", id: approval.id, value: "Allow for session" });
				await task;
				await client.dispatch({ action: "scopeModels", models: ["gui-fixture/second", "gui-fixture/test"] });
				const before = client.snapshot().messages;
				await client.dispatch({ action: "new" });
				vi.setSystemTime(Date.now() + 60_000);
				await service.collect();
				await client.dispatch({ action: "selectSession", id: a });
				expect(client.runtime).not.toBe(original);
				expect(client.snapshot().messages).toEqual(before);
				expect(client.snapshot().scopedModels).toEqual(["gui-fixture/second", "gui-fixture/test"]);
				await client.dispatch(prompt("相同路径再次写入"));
				expect(client.dialogs.list()).toEqual([]);
				expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI SDK result\n");
				await client.dispatch({ action: "new" });
				vi.setSystemTime(Date.now() + 60_000);
				await service.collect();
				const modelsFile = path.join(agentDir, "models.json");
				const modelConfig = JSON.parse(await readFile(modelsFile, "utf8")) as { providers: Record<string, { models: { id: string }[] }> };
				const provider = modelConfig.providers["gui-fixture"];
				if (!provider) throw new Error("缺少测试提供方");
				provider.models = provider.models.filter((model) => model.id !== "second");
				await writeFile(modelsFile, JSON.stringify(modelConfig));
				await client.dispatch({ action: "selectSession", id: a });
				expect(client.snapshot().scopedModels).toEqual(["gui-fixture/test"]);
				expect(client.snapshot().messages.length).toBeGreaterThan(before.length);
				await client.dispatch({ action: "new" });
				const separate = client.dispatch(prompt("新会话不继承授权"));
				await expect.poll(() => client.dialogs.list().length).toBe(1);
				await client.dispatch({ action: "abort" });
				await separate;
			} finally { await service.dispose(); }
		});
	});
}
