import type { Message } from "@earendil-works/pi-ai";

export function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

export function assistantToolCall(
	name: string,
	args: Record<string, unknown>,
	text?: string,
): Message {
	return {
		role: "assistant",
		content: [
			...(text === undefined ? [] : [{ type: "text" as const, text }]),
			{ type: "toolCall", id: `${name}-1`, name, arguments: args },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

export function toolResult(toolName: string, text: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-1`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}
