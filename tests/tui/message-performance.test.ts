import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createAssistantPerformanceTracker,
	getAssistantPerformance,
	resetAssistantPerformanceMeasurements,
} from "../../src/tui/message-performance.js";

beforeEach(() => {
	resetAssistantPerformanceMeasurements();
});

describe("assistant message performance", () => {
	it("TTFT 同时保留可见思考和正文口径，TPS 只使用正文", () => {
		let now = 0;
		const tracker = createAssistantPerformanceTracker(() => now);
		const message = assistantMessage([
			{ type: "thinking", thinking: "summary" },
			{ type: "text", text: "Hello world" },
		]);

		tracker.startRequest();
		tracker.startMessage(message);
		now = 50;
		tracker.updateMessage(message, update(message, "thinking_delta", " "));
		now = 100;
		tracker.updateMessage(message, update(message, "thinking_delta", "summary"));
		now = 400;
		tracker.updateMessage(message, update(message, "text_delta", "\n"));
		now = 500;
		tracker.updateMessage(message, update(message, "text_delta", "Hello"));
		now = 600;
		tracker.updateMessage(message, update(message, "text_delta", " world"));
		tracker.endMessage(message);

		expect(getAssistantPerformance(message)).toEqual({
			bodyTps: 20,
			ttftWithThinkingMs: 100,
			ttftWithoutThinkingMs: 500,
		});
	});

	it("正文只有一个观测点时不伪造 TPS", () => {
		let now = 0;
		const tracker = createAssistantPerformanceTracker(() => now);
		const message = assistantMessage([{ type: "text", text: "buffered response" }]);

		tracker.startRequest();
		tracker.startMessage(message);
		now = 200;
		tracker.updateMessage(message, update(message, "text_delta", "buffered response"));
		tracker.endMessage(message);

		expect(getAssistantPerformance(message)).toBeUndefined();
	});

	it("新 HTTP attempt 覆盖失败重试的起点", () => {
		let now = 0;
		const tracker = createAssistantPerformanceTracker(() => now);
		const message = assistantMessage([{ type: "text", text: "Hello world" }]);

		tracker.startRequest();
		now = 1_000;
		tracker.startRequest();
		tracker.startMessage(message);
		now = 1_200;
		tracker.updateMessage(message, update(message, "text_delta", "Hello"));
		now = 1_300;
		tracker.updateMessage(message, update(message, "text_delta", " world"));
		tracker.endMessage(message);

		expect(getAssistantPerformance(message)?.ttftWithoutThinkingMs).toBe(200);
	});
});

function update(
	message: AssistantMessage,
	type: "text_delta" | "thinking_delta",
	delta: string,
): AssistantMessageEvent {
	return { type, contentIndex: 0, delta, partial: message };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}
