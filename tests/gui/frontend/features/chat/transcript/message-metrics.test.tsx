import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReplyMetrics } from "../../../../../../src/gui/frontend/features/chat/messages/message-meta.tsx";
import { transcriptReplies } from "../../../../../../src/gui/frontend/features/chat/transcript/transcript-replies.ts";
import { assistant, call, result, source } from "../../../../helpers/transcript-fixtures.ts";
import { guiModelFixture } from "../../../../helpers/snapshot-fixture.ts";

const user = { role: "user", content: "检查项目", timestamp: 1 } as const;
const first = assistant([call]);
const last = { ...assistant([{ type: "text", text: "完成" }], "stop"), timestamp: 200,
	usage: { input: 120, output: 40, cacheRead: 80, cacheWrite: 10, totalTokens: 250,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033, totalFromProvider: true } } };

describe("消息身份和本轮统计", () => {
	it("历史工具调用轮次汇总用量和费用，但不将请求耗时换算成正文速度", () => {
		const reply = transcriptReplies(source({ messages: [user, { ...first, durationMs: 1000 }, result, { ...last, durationMs: 1000 }] }))
			.find((row) => row.kind === "reply");
		expect(reply?.metrics).toEqual({ input: 121, output: 41, cacheRead: 80, cacheWrite: 10, cost: 0.033, costFromProvider: false });
		expect(reply?.answer[0]).toMatchObject({ kind: "text", speed: null, metrics: { costFromProvider: true } });
		const answer = reply?.answer[0];
		if (!reply || !answer) throw new Error("缺少回复");
		const billed = renderToStaticMarkup(createElement(ReplyMetrics, { ...answer.metrics, speed: null }));
		expect(billed).toContain("费用 $0.0330");
		expect(billed).not.toContain("估算");
		expect(renderToStaticMarkup(createElement(ReplyMetrics, { ...reply.metrics, speed: null }))).toContain("估算费用");
	});

	it("每轮独立统计，已移除模型仍显示消息记录中的模型标识", () => {
		const rows = transcriptReplies(source({ messages: [user, first, result, last,
			{ ...user, timestamp: 300 }, { ...first, timestamp: 400 }],
			models: [guiModelFixture({ name: "Test Model", contextWindow: 1000 })],
		})).filter((row) => row.kind === "reply");
		expect(rows.map((row) => row.metrics.input)).toEqual([121, 1]);
		expect(rows[0]?.lastAssistant).toEqual({ index: 3, model: "Test Model", timestamp: 200 });
		const history = transcriptReplies(source({ messages: [user, { ...last, responseModel: "concrete-model" }] }));
		expect(history[1]).toMatchObject({ lastAssistant: { index: 1, model: "test → concrete-model", timestamp: 200 },
			metrics: { costFromProvider: true } });
	});
});
