import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GuiPayloads } from "../../src/gui/host/payloads.ts";
import type { TranscriptSource } from "../../src/gui/ui/transcript/transcript-items.ts";

export function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return {
		role: "assistant", content, api: "openai-completions", provider: "test", model: "test", timestamp: 100,
		stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
export const call = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "app.ts", lines: "1-3" } } as const;
export const result: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, timestamp: 101, content: [{ type: "text", text: "file content" }] };
export function source(value: Partial<Omit<TranscriptSource, "messages" | "streamingMessage" | "liveTools">> & {
	messages?: AgentMessage[]; streamingMessage?: AgentMessage | null;
	liveTools?: Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" }>[];
}): TranscriptSource {
	const payloads = new GuiPayloads();
	return { models: [], messageDurations: {}, streaming: false, retrying: false, ...value,
		messages: (value.messages ?? []).map((message) => payloads.message(message)),
		streamingMessage: payloads.stream(value.streamingMessage ?? null),
		liveTools: (value.liveTools ?? []).map((event) => ({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, status: "running",
			...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			output: event.type === "tool_execution_update" ? payloads.output(event.toolName, event.partialResult) : undefined })),
	};
}
