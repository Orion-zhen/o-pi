import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GuiNestedCalls, ToolOutput } from "../../shared/messages/types.ts";
import type { GuiPayloads } from "./payloads.ts";

export const NESTED_MUTATION_ENTRY = "opi.gui.nested-mutation";

export interface NestedMutation {
	toolCallId: string;
	toolName: "write" | "edit";
	diff: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只保留真实执行结果中的 diff，不从调用参数推测文件变更。 */
export function nestedMutation(toolCallId: string, toolName: string, result: ToolOutput): NestedMutation | undefined {
	if ((toolName !== "write" && toolName !== "edit") || !record(result.details) || typeof result.details.diff !== "string") return undefined;
	return { toolCallId, toolName, diff: result.details.diff };
}

function parseMutation(value: unknown): NestedMutation | undefined {
	if (!record(value) || typeof value.toolCallId !== "string"
		|| (value.toolName !== "write" && value.toolName !== "edit") || typeof value.diff !== "string") return undefined;
	return { toolCallId: value.toolCallId, toolName: value.toolName, diff: value.diff };
}

/** 一次遍历恢复未缓存的结果，离开分支时撤销索引变更，避免同名调用串入其他分支。 */
export function restoreNestedMutations(entries: readonly SessionEntry[], targets: ReadonlyMap<string, GuiNestedCalls>, payloads: GuiPayloads): Map<string, GuiNestedCalls> {
	const restored = new Map<string, GuiNestedCalls>();
	if (!targets.size) return restored;
	const ids = new Set(entries.map((entry) => entry.id));
	const children = new Map<string | null, SessionEntry[]>();
	for (const entry of entries) {
		const parent = entry.parentId && ids.has(entry.parentId) ? entry.parentId : null;
		const siblings = children.get(parent);
		if (siblings) siblings.push(entry);
		else children.set(parent, [entry]);
	}
	const mutations = new Map<string, NestedMutation>();
	const pending: (SessionEntry | (() => void))[] = [...children.get(null) ?? []].reverse();
	while (true) {
		const entry = pending.pop();
		if (!entry) break;
		if (typeof entry === "function") { entry(); continue; }
		if (entry.type === "custom" && entry.customType === NESTED_MUTATION_ENTRY) {
			const mutation = parseMutation(entry.data);
			if (mutation) {
				const previous = mutations.get(mutation.toolCallId);
				mutations.set(mutation.toolCallId, mutation);
				pending.push(() => {
					if (previous) mutations.set(mutation.toolCallId, previous);
					else mutations.delete(mutation.toolCallId);
				});
			}
		}
		const nestedCalls = targets.get(entry.id);
		if (nestedCalls) {
			restored.set(entry.id, { ...nestedCalls, calls: nestedCalls.calls.map((call) => {
				const mutation = mutations.get(call.id);
				return mutation && mutation.toolName === call.name && call.status === "ok"
					? { ...call, output: payloads.output(call.name, { content: [], details: { diff: mutation.diff } }) } : call;
			}) });
		}
		for (const child of [...children.get(entry.id) ?? []].reverse()) pending.push(child);
	}
	return restored;
}
