import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { GuiLiveTool } from "../../contract.ts";
import type { GuiNestedCall } from "../../messages.ts";
import type { GuiPayloads } from "./payloads.ts";
import { nestedMutation, type NestedMutation } from "./nested-mutations.ts";

type ToolEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>;
interface LiveCall { rootId: string; value: GuiNestedCall }

/** 按 SDK 生命周期维护调用。界面只接收顶层工具及统一的嵌套记录。 */
export class GuiLiveTools {
	private calls = new Map<string, LiveCall>();

	constructor(private payloads: GuiPayloads) {}

	get size(): number { return this.calls.size; }

	accept(event: ToolEvent): NestedMutation | undefined {
		const id = event.toolCallId;
		if (event.type === "tool_execution_start") {
			const rootId = event.parentToolCallId === undefined ? id : this.get(event.parentToolCallId).rootId;
			this.calls.set(id, { rootId, value: { id, name: event.toolName, arguments: structuredClone(event.args), status: "unfinished" } });
			return;
		}
		const current = this.get(id);
		if (event.type === "tool_execution_update") {
			this.calls.set(id, { ...current, value: { ...current.value, arguments: structuredClone(event.args),
				output: this.payloads.progress(id, event.toolName, structuredClone(event.partialResult)) } });
			return;
		}
		if (current.rootId === id) {
			for (const [callId, call] of this.calls) if (call.rootId === id) this.calls.delete(callId);
			return;
		}
		const mutation = event.isError ? undefined : nestedMutation(id, event.toolName, event.result);
		const output = mutation ? this.payloads.complete(id, event.toolName, { content: [], details: { diff: mutation.diff } })
			: event.isError ? this.payloads.complete(id, event.toolName, structuredClone(event.result)) : undefined;
		const { output: _progress, ...value } = current.value;
		this.calls.set(id, { ...current, value: { ...value, status: event.isError ? "error" : "ok",
			...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			...(output ? { output } : {}),
		} });
		return mutation;
	}

	private get(id: string): LiveCall {
		const call = this.calls.get(id);
		if (!call) throw new Error(`工具调用缺少起点: ${id}`);
		return call;
	}

	project(): GuiLiveTool[] {
		const tools: GuiLiveTool[] = [];
		const nested = new Map<string, GuiNestedCall[]>();
		for (const { rootId, value } of this.calls.values()) {
			if (value.id === rootId) tools.push({ toolCallId: value.id, toolName: value.name, args: value.arguments, output: value.output });
			else {
				const calls = nested.get(rootId);
				if (calls) calls.push(value);
				else nested.set(rootId, [value]);
			}
		}
		return tools.map((tool) => {
			const calls = nested.get(tool.toolCallId);
			return calls ? { ...tool, nestedCalls: { complete: false, calls } } : tool;
		});
	}
}
