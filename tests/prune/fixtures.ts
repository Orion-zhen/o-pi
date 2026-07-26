import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { PRUNE_STATE, type PruneState } from "../../src/prune/prune.js";

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

export function assistant(content: AssistantMessage["content"], usage: Usage = ZERO_USAGE): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

export function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

export function solModel(
	tier?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number },
): Model<Api> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			...(tier ? { tiers: [tier] } : {}),
		},
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

export function pruneState(toolCallIds: string[], previousToolCallIds: string[] = []): PruneState {
	return { operation: "prune", toolCallIds, previousToolCallIds };
}

export function restoreState(toolCallIds: string[], restoredEntryId: string): PruneState {
	return { operation: "restore", toolCallIds, restoredEntryId };
}

export function customEntry(
	customType: string,
	data: unknown,
	id = `${customType}-${JSON.stringify(data).length}`,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-23T00:00:00.000Z",
		customType,
		data,
	};
}

export function pruneEntry(id: string, data: PruneState): SessionEntry {
	return customEntry(PRUNE_STATE, data, id);
}

export function messageEntry(id: string, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-23T00:00:00.000Z",
		message,
	};
}

export function transactionEntries(): SessionEntry[] {
	const cachedUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 10_000,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0.005, cacheWrite: 0, total: 0.005 },
	};
	return [
		messageEntry("user", user("inspect")),
		messageEntry("assistant", assistant(
			[{ type: "toolCall", id: "done", name: "read", arguments: { path: "a.ts" } }],
			cachedUsage,
		)),
		messageEntry("result", toolResult("done", "large output ".repeat(100))),
	];
}
