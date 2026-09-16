import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageTiming } from "../../src/gui/host/message-timing.ts";
import { assistantKey, replyMetrics } from "../../src/gui/message-metrics.ts";
import { transcriptReplies } from "../../src/gui/ui/transcript-replies.ts";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const user = { role: "user", content: "检查项目", timestamp: 1 } as const;
const first = assistant([call]);
const last = { ...assistant([{ type: "text", text: "完成" }], "stop"), timestamp: 200,
	usage: { input: 120, output: 40, cacheRead: 80, cacheWrite: 10, totalTokens: 250,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 } } };

afterEach(() => vi.restoreAllMocks());

describe("消息身份和本轮统计", () => {
	it("跨工具调用汇总 tokens、缓存、费用，速度排除工具耗时", () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const timing = new MessageTiming();
		timing.accept({ type: "turn_start" });
		now = 1000;
		timing.accept({ type: "message_end", message: first });
		now = 11000;
		timing.accept({ type: "message_end", message: result });
		timing.accept({ type: "turn_start" });
		now = 12000;
		timing.accept({ type: "message_end", message: last });
		expect(replyMetrics([first, last], timing.durations)).toEqual({
			input: 121, output: 41, cacheRead: 80, cacheWrite: 10, cost: 0.033, speed: 20.5,
		});
	});

	it("历史缺少任一调用计时时不计算误导性的速度", () => {
		expect(replyMetrics([first, last], { [assistantKey(last)]: 1000 }).speed).toBeNull();

	});

	it("每轮独立统计，已移除模型仍显示消息记录中的模型标识", () => {
		const rows = transcriptReplies(source({ messages: [user, first, result, last,
			{ ...user, timestamp: 300 }, { ...first, timestamp: 400 }],
			models: [{ id: "test", provider: "test", name: "Test Model", contextWindow: 1000 }],
		})).filter((row) => row.kind === "reply");
		expect(rows.map((row) => row.metrics.input)).toEqual([121, 1]);
		expect(rows[0]?.identity).toEqual({ model: "Test Model", timestamp: 200 });
		const history = transcriptReplies(source({ messages: [user, last] }));
		expect(history[1]).toMatchObject({ identity: { model: "test", timestamp: 200 } });
	});

});
