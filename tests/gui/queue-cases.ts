import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GuiClient } from "../../src/gui/host/client.ts";
import type { GuiSnapshot } from "../../src/gui/contract.ts";
import { GuiReceiver } from "../../src/gui/sync.ts";

export function queueTests(context: () => { host: GuiClient; agentDir: string }) {
	describe("GUI 消息队列同步", () => {
		it("运行中逐次入队和清空通过增量通道同步，旧快照保持不变", async () => {
			const { host, agentDir } = context();
			await writeFile(path.join(agentDir, "configs", "approval-gate.jsonc"), '{"tools":{"write":{"default_action":"ask"}}}');
			const receiver = new GuiReceiver();
			const received: GuiSnapshot[] = [];
			const connection = host.connect((delivery) => {
				for (const event of structuredClone(delivery).events) {
					const value = receiver.accept(event);
					if (value.type === "snapshot" && value.value) received.push(value.value);
				}
				connection.acknowledge(delivery.id);
			});
			const task = host.dispatch({ action: "prompt", text: "读取文件并写入结果", images: [], behavior: "followUp" });
			try {
				await expect.poll(() => host.dialogs.list().length).toBe(1);
				const initial = host.snapshot();
				await host.dispatch({ action: "prompt", text: "第一条引导", images: [], behavior: "steer" });
				await expect.poll(() => received.at(-1)?.queue).toEqual({ steering: ["第一条引导"], followUp: [] });
				const first = host.snapshot();
				await host.dispatch({ action: "prompt", text: "第二条引导", images: [], behavior: "steer" });
				await host.dispatch({ action: "prompt", text: "跟进消息", images: [], behavior: "followUp" });
				const queued = { steering: ["第一条引导", "第二条引导"], followUp: ["跟进消息"] };
				await expect.poll(() => received.at(-1)?.queue).toEqual(queued);
				const beforeClear = host.snapshot();
				await host.dispatch({ action: "clearQueue" });
				await expect.poll(() => received.at(-1)?.queue).toEqual({ steering: [], followUp: [] });
				expect(initial.queue).toEqual({ steering: [], followUp: [] });
				expect(first.queue).toEqual({ steering: ["第一条引导"], followUp: [] });
				expect(beforeClear.queue).toEqual(queued);
			} finally {
				connection.close();
				await host.dispatch({ action: "abort" });
				await task;
			}
		});
	});
}
