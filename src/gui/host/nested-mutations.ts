import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GuiMessage, ToolOutput } from "../messages.ts";
import type { GuiPayloads } from "./payloads.ts";

export const NESTED_MUTATION_ENTRY = "opi.gui.nested-mutation";

interface NestedMutation {
	parentToolCallId: string;
	toolCallId: string;
	toolName: "write" | "edit";
	diff: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只保留真实执行结果中的 diff，不从调用参数推测文件变更。 */
export function nestedMutation(parentToolCallId: string, toolCallId: string, toolName: string, result: ToolOutput): NestedMutation | undefined {
	if ((toolName !== "write" && toolName !== "edit") || !record(result.details) || typeof result.details.diff !== "string") return undefined;
	return { parentToolCallId, toolCallId, toolName, diff: result.details.diff };
}

function parseMutation(value: unknown): NestedMutation | undefined {
	if (!record(value) || typeof value.parentToolCallId !== "string" || typeof value.toolCallId !== "string"
		|| (value.toolName !== "write" && value.toolName !== "edit") || typeof value.diff !== "string") return undefined;
	return { parentToolCallId: value.parentToolCallId, toolCallId: value.toolCallId, toolName: value.toolName, diff: value.diff };
}

/** 从父结果所在分支恢复界面数据，custom 条目不进入模型上下文。 */
export function restoreNestedMutations(message: GuiMessage, branch: readonly SessionEntry[], payloads: GuiPayloads): GuiMessage {
	if (message.role !== "toolResult" || !message.nestedCalls) return message;
	const mutations = new Map<string, NestedMutation>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== NESTED_MUTATION_ENTRY) continue;
		const mutation = parseMutation(entry.data);
		if (mutation?.parentToolCallId === message.toolCallId) mutations.set(mutation.toolCallId, mutation);
	}
	return { ...message, nestedCalls: { ...message.nestedCalls, calls: message.nestedCalls.calls.map((call) => {
		const mutation = mutations.get(call.id);
		return mutation && mutation.toolName === call.name && call.status === "ok"
			? { ...call, output: payloads.output(call.name, { content: [], details: { diff: mutation.diff } }) } : call;
	}) } };
}
