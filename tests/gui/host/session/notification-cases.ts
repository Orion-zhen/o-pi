import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import type { GuiEvent } from "../../../../src/gui/shared/protocol/events.ts";
import { preserveEnv } from "../../../helpers/lifecycle.ts";

const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });
function connect(client: GuiClient) {
	const events: GuiEvent[] = [];
	const connection = client.connect((delivery) => {
		if (delivery.kind === "notification") events.push({ type: "notification", value: delivery.value });
		else connection.acknowledge(delivery.id);
	});
	return {
		events, close: connection.close,
		attend: (focused: boolean) => connection.attend({ sessionId: client.selected?.id ?? null, focused, destination: "web:browser" }),
	};
}

export function notificationTests(context: () => { host: GuiClient; agentDir: string }) {
	describe("会话系统通知", () => {
		preserveEnv("OPI_NO_NOTIFICATIONS");
		beforeEach(() => { delete process.env.OPI_NO_NOTIFICATIONS; });
		it("只抑制已展示的前台会话，后台完成取首条消息摘要", async () => {
			const { host } = context();
			const connection = connect(host);
			const a = host.runtime.session.sessionId;
			connection.attend(true);
			await host.dispatch({ action: "openSession", id: a });
			await host.dispatch(prompt("前台任务"));
			expect(connection.events).toEqual([]);
			await host.dispatch({ action: "new" });
			const b = host.runtime.session.sessionId;
			await host.dispatch(prompt("后台任务第一条"), b);
			expect(connection.events).toHaveLength(1);
			connection.attend(true);
			await host.dispatch(prompt("页面已展示新会话"), b);
			expect(connection.events).toHaveLength(1);
			await host.dispatch({ action: "openSession", id: a });
			connection.attend(true);
			await host.dispatch(prompt("后台任务第二条"), b);
			expect(connection.events).toEqual([1, 2].map(() => ({ type: "notification", value: { kind: "completed", sessionId: b, name: undefined, firstMessage: "后台任务第一条" } })));
			connection.close();
		});

		it("任一窗口关注目标会话就抑制，断连后同浏览器多标签只投递一次", async () => {
			const { host } = context();
			const id = host.runtime.session.sessionId;
			const second = host.host.createClient();
			const third = host.host.createClient();
			const connections = [host, second, third].map(connect);
			try {
				await second.dispatch({ action: "openSession", id });
				await third.dispatch({ action: "openSession", id });
				connections.forEach((connection, index) => connection.attend(index === 1));
				await host.dispatch(prompt("被另一窗口查看"));
				expect(connections.flatMap((connection) => connection.events)).toEqual([]);
				connections[1]?.close();
				await host.dispatch({ action: "rename", name: "通知测试" });
				await host.dispatch(prompt("所有窗口失焦"));
				expect(connections.flatMap((connection) => connection.events)).toEqual([
					{ type: "notification", value: expect.objectContaining({ name: "通知测试", sessionId: id, kind: "completed" }) },
				]);
				process.env.OPI_NO_NOTIFICATIONS = "1";
				await host.dispatch(prompt("禁用通知"));
				expect(connections.flatMap((connection) => connection.events)).toHaveLength(1);
			} finally {
				for (const connection of connections) connection.close();
				second.close(); third.close();
			}
		});

		it("后台审批独立于当前会话订阅，取消审批不发完成通知", async () => {
			const { host, agentDir } = context();
			await host.dispatch(prompt("后台写文件"));
			await writeFile(path.join(agentDir, "configs", "approval-gate.jsonc"), '{"tools":{"write":{"default_action":"ask"}}}');
			const id = host.runtime.session.sessionId;
			const execution = host.execution;
			await host.dispatch({ action: "new" });
			const connection = connect(host);
			connection.attend(true);
			const task = host.dispatch(prompt("后台写文件"), id);
			try {
				await expect.poll(() => execution.dialogs.list().length).toBe(1);
				expect(connection.events).toEqual([
					{ type: "notification", value: expect.objectContaining({ kind: "approval", sessionId: id, toolName: "write", firstMessage: "后台写文件" }) },
				]);
			} finally { await host.dispatch({ action: "abort" }, id); await task; connection.close(); }
			expect(connection.events).toHaveLength(1);
		});
	});
}
