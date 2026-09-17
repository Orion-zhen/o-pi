import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { TranscriptSource } from "../../src/gui/ui/transcript-items.ts";

export function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return {
		role: "assistant", content, api: "openai-completions", provider: "test", model: "test", timestamp: 100,
		stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
export const call = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "app.ts", lines: "1-3" } } as const;
export const result: ToolResultMessage<unknown> = { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, timestamp: 101, content: [{ type: "text", text: "file content" }] };
export function source(value: Partial<TranscriptSource>): TranscriptSource {
	return { messages: [], models: [], messageDurations: {}, streamingMessage: null, liveTools: [], streaming: false, retrying: false, ...value };
}
