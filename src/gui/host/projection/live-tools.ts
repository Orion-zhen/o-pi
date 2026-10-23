import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { GuiLiveTool } from "../../shared/protocol/state.ts";
import type { GuiNestedCall, GuiToolOutput } from "../../shared/messages/types.ts";
import type { GuiPayloads } from "./payloads.ts";
import { nestedMutation, type NestedMutation } from "./nested-mutations.ts";

type ToolEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>;
interface LiveCall { rootId: string; value: GuiNestedCall }

/** 按 SDK 生命周期维护调用。界面只接收顶层工具及统一的嵌套记录。 */
export class GuiLiveTools {
	private calls = new Map<string, LiveCall>();

	constructor(private payloads: GuiPayloads) {}

	get size(): number {
		let size = 0;
		for (const { rootId } of this.calls.values()) if (this.get(rootId).value.status === "unfinished") size++;
		return size;
	}

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
		const root = current.rootId === id;
		const mutation = root || event.isError ? undefined : nestedMutation(id, event.toolName, event.result);
		let output: GuiToolOutput | undefined;
		if (root) output = this.payloads.retainResult(id, event.toolName, structuredClone(event.result));
		else if (mutation) output = this.payloads.complete(id, event.toolName, { content: [], details: { diff: mutation.diff } });
		else if (event.isError) output = this.payloads.complete(id, event.toolName, structuredClone(event.result));
		const { output: _progress, ...value } = current.value;
		this.calls.set(id, { ...current, value: { ...value, status: event.isError ? "error" : "ok",
			...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			...(output ? { output } : {}),
		} });
		return mutation;
	}

	settle(id: string): void {
		for (const [callId, call] of this.calls) if (call.rootId === id) this.calls.delete(callId);
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
			if (value.id === rootId) tools.push({
				toolCallId: value.id, toolName: value.name, args: value.arguments, output: value.output,
				...(value.status === "unfinished" ? {} : { completion: {
					isError: value.status === "error", ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
				} }),
			});
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
