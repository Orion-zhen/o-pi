import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageTiming } from "../../src/gui/host/message-timing.ts";
import { assistantKey, replyMetrics } from "../../src/gui/message-metrics.ts";
import { MessageIdentity } from "../../src/gui/ui/message-meta.tsx";
import { transcriptReplies } from "../../src/gui/ui/transcript-replies.ts";
import { Transcript } from "../../src/gui/ui/transcript.tsx";
import { assistant, call, result, source } from "./transcript-fixtures.ts";

const user = { role: "user", content: "检查项目", timestamp: 1 } as const;
const first = assistant([call]);
const last = { ...assistant([{ type: "text", text: "完成" }], "stop"), timestamp: 200,
	usage: { input: 120, output: 40, cacheRead: 80, cacheWrite: 10, totalTokens: 250,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 } } };

afterEach(() => vi.restoreAllMocks());

describe("消息身份和本轮统计", () => {
	it("按本地时间补齐年月日与时分秒", () => {
		const timestamp = new Date(2026, 8, 6, 9, 4, 5).getTime();
		const html = renderToStaticMarkup(createElement(MessageIdentity, { name: "You", timestamp }));
		expect(html).toContain("2026-09-06 09:04:05");
		expect(html).toContain(new Date(timestamp).toISOString());
	});

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
		const html = renderToStaticMarkup(createElement(Transcript, { source: source({ messages: [user, first, result, last] }) }));
		expect(html).toContain("速度 —");
		expect(html).toContain("输入 121");
		expect(html).toContain("缓存读取 80");
		expect(html).toContain("$0.0330");
		expect(html.indexOf("You")).toBeLessThan(html.indexOf("user-bubble"));
		expect(html.indexOf("</details><header class=\"message-identity\"")).toBeGreaterThan(0);
		expect(html.indexOf("reply-metrics")).toBeGreaterThan(html.indexOf("完成"));
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

	it("生成中不展示未结算的统计，终止后显示已产生的用量", () => {
		const html = renderToStaticMarkup(createElement(Transcript, { source: source({ messages: [user], streamingMessage: last, streaming: true }) }));
		expect(html).not.toContain("reply-metrics");
		const stopped = renderToStaticMarkup(createElement(Transcript, { source: source({ messages: [user, { ...last, stopReason: "aborted" }] }) }));
		expect(stopped).toContain("已停止");
		expect(stopped).toContain("输出 40");
	});
});
