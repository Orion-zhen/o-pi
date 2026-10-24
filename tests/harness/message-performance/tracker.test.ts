import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantPerformanceTracker } from "../../../src/harness/message-performance/tracker.ts";
import { getAssistantPerformance } from "../../../src/harness/message-performance/types.ts";

let now = 0;
beforeEach(() => {
	now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("共享正文计时", () => {
	it("正文分块结算，排除首字等待与中间思考，TTFT 保留思考和正文口径", () => {
		const tracker = createAssistantPerformanceTracker();
		const message = assistantMessage();
		tracker.startRequest();
		tracker.startMessage();
		now = 100;
		tracker.updateMessage(message, update(message, "thinking_delta", "summary"));
		tracker.updateMessage(message, { type: "thinking_end", contentIndex: 0, content: "summary", partial: message });
		now = 500;
		tracker.updateMessage(message, update(message, "text_delta", "Hello", 1));
		now = 600;
		tracker.updateMessage(message, update(message, "text_delta", " world", 1));
		tracker.updateMessage(message, { type: "text_end", contentIndex: 1, content: "Hello world", partial: message });
		const first = getAssistantPerformance(message);
		now = 1_000;
		tracker.updateMessage(message, update(message, "thinking_delta", "reasoning", 2));
		tracker.updateMessage(message, { type: "thinking_end", contentIndex: 2, content: "reasoning", partial: message });
		now = 10_000;
		tracker.updateMessage(message, update(message, "text_delta", "Hello", 3));
		now = 10_200;
		tracker.updateMessage(message, update(message, "text_delta", " again", 3));
		tracker.updateMessage(message, { type: "text_end", contentIndex: 3, content: "Hello again", partial: message });
		message.stopReason = "stop";
		tracker.endMessage(message);

		expect(first).toEqual({ bodyTps: { 1: 10 }, ttftWithThinkingMs: 100, ttftWithoutThinkingMs: 500 });
		expect(getAssistantPerformance(message)).toEqual({
			bodyTps: { 1: 10, 3: 5 }, ttftWithThinkingMs: 100, ttftWithoutThinkingMs: 500,
		});
	});

	it("Responses 结束事件改写正文时不使用旧片段估算速度", () => {
		const tracker = createAssistantPerformanceTracker();
		const message = assistantMessage();
		tracker.startRequest();
		tracker.startMessage();
		now = 100;
		tracker.updateMessage(message, update(message, "text_delta", "Hello"));
		now = 200;
		tracker.updateMessage(message, update(message, "text_delta", " world"));
		message.content[0] = { type: "text", text: "Rewritten response" };
		tracker.updateMessage(message, { type: "text_end", contentIndex: 0, content: "Rewritten response", partial: message });
		message.stopReason = "stop";
		tracker.endMessage(message);

		expect(getAssistantPerformance(message)?.bodyTps).toEqual({ 0: null });
	});

	it("用户取消生成时不补算未结束的正文", () => {
		const tracker = createAssistantPerformanceTracker();
		const message = assistantMessage();
		tracker.startRequest();
		tracker.startMessage();
		now = 100;
		tracker.updateMessage(message, update(message, "text_delta", "Hello"));
		now = 200;
		tracker.updateMessage(message, update(message, "text_delta", " world"));
		message.stopReason = "aborted";
		tracker.endMessage(message);

		expect(getAssistantPerformance(message)?.bodyTps).toEqual({});
	});

	it("请求重试后从最近一次请求计算首字等待", () => {
		const tracker = createAssistantPerformanceTracker();
		const message = assistantMessage();
		tracker.startRequest();
		now = 1_000;
		tracker.startRequest();
		tracker.startMessage();
		now = 1_200;
		tracker.updateMessage(message, update(message, "text_delta", "Hello"));
		tracker.updateMessage(message, { type: "text_end", contentIndex: 0, content: "Hello", partial: message });
		message.stopReason = "stop";
		tracker.endMessage(message);

		expect(getAssistantPerformance(message)?.ttftWithoutThinkingMs).toBe(200);
	});
});

function update(message: AssistantMessage, type: "text_delta" | "thinking_delta", delta: string, contentIndex = 0): AssistantMessageEvent {
	const block = message.content[contentIndex];
	message.content[contentIndex] = type === "text_delta"
		? { type: "text", text: (block?.type === "text" ? block.text : "") + delta }
		: { type: "thinking", thinking: (block?.type === "thinking" ? block.thinking : "") + delta };
	return { type, contentIndex, delta, partial: message };
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "gpt-test",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending", timestamp: 1,
	};
}
