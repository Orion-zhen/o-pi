import { describe, expect, it } from "vitest";
import { replyMetrics } from "../../src/gui/frontend/features/chat/messages/metrics.ts";
import { transcriptReplies } from "../../src/gui/frontend/features/chat/transcript/transcript-replies.ts";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const user = { role: "user", content: "检查项目", timestamp: 1 } as const;
const first = assistant([call]);
const last = { ...assistant([{ type: "text", text: "完成" }], "stop"), timestamp: 200,
	usage: { input: 120, output: 40, cacheRead: 80, cacheWrite: 10, totalTokens: 250,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 } } };

describe("消息身份和本轮统计", () => {
	it("跨工具调用汇总 tokens、缓存、费用，速度排除工具耗时", () => {
		expect(replyMetrics([{ ...first, durationMs: 1000 }, { ...last, durationMs: 1000 }])).toEqual({
			input: 121, output: 41, cacheRead: 80, cacheWrite: 10, cost: 0.033, speed: 20.5,
		});
	});

	it("历史缺少任一调用计时时不计算误导性的速度", () => {
		expect(replyMetrics([first, { ...last, durationMs: 1000 }]).speed).toBeNull();
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
