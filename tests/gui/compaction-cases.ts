import { describe, expect, it } from "vitest";
import type { GuiClient } from "../../src/gui/host/client.ts";
import type { GuiEvent } from "../../src/gui/contract.ts";
import type { ModelResponse } from "../cli/model-server.ts";
import { deferred } from "../helpers/async.ts";
import { readSnapshot } from "./read-snapshot.ts";

export function compactionTests(context: () => {
	host: GuiClient;
	events: GuiEvent[];
	setSummaryReply: (reply: () => Promise<ModelResponse>) => void;
}) {
	describe("GUI 自动压缩", () => {
		it.each([
			{ name: "both", trigger: "agentEnd", queue: [{ text: "排队的引导", behavior: "steer" }, { text: "排队的跟进", behavior: "followUp" }], cancel: true },
			{ name: "beforePrompt", trigger: "beforePrompt", queue: [], cancel: true },
			{ name: "complete", trigger: "agentEnd", queue: [], cancel: false },
		] as const)("压缩结束后恢复状态，SDK 继续处理待发送消息：$name", async ({ trigger, queue, cancel }) => {
			const { host, events, setSummaryReply } = context();
			const prompt = (text: string, behavior: "steer" | "followUp" = "followUp") => host.dispatch({ action: "prompt", text, images: [], behavior });
			await prompt("第一轮");
			await prompt("第二轮");
			const { session, services } = host.runtime;
			const summary = deferred<ModelResponse>();
			const started = deferred<void>();
			setSummaryReply(() => { started.resolve(); return summary.promise; });
			const settings = services.settingsManager;
			const enable = () => settings.applyOverrides({ compaction: { enabled: true, reserveTokens: 127999, keepRecentTokens: 1 } });
			let triggered = false;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "agent_end" && !triggered && trigger === "agentEnd") enable();
				if (event.type === "compaction_start") {
					triggered = true;
					// 后续消息不再次跨过阈值，自动压缩开关保持开启。
					settings.applyOverrides({ compaction: { reserveTokens: 16384 } });
				}
			});
			if (trigger === "beforePrompt") enable();
			const task = prompt("第三轮");
			try {
				await Promise.race([started.promise, task.then(() => { throw new Error("未触发自动压缩"); })]);
				await expect.poll(() => events.findLast((event) => event.type === "snapshot")?.value?.compacting).toBe(true);
				expect(readSnapshot(host)).toMatchObject({ compacting: true, running: true });
				for (const { text, behavior } of queue) await prompt(text, behavior);
				if (cancel) await host.dispatch({ action: "abort" });
				else summary.resolve({ text: "已完成两轮文件读写" });
				await task;
				const snapshot = readSnapshot(host);
				expect(snapshot).toMatchObject({ compacting: false, running: false,
					queue: { steering: [], followUp: [] }, settings: { compaction: true } });
				const users = snapshot.entries.flatMap((entry) => entry.messages).filter((message) => message.role === "user").map((message) =>
					typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
				expect(users).toEqual(["第一轮", "第二轮", "第三轮", ...queue.map(({ text }) => text)]);
				expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(!cancel);
			} finally {
				unsubscribe();
				summary.resolve({ text: "不应保存的摘要" });
				await task;
			}
		});
	});
}
