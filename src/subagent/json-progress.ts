import type { Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RenderEvent, ToolProgressStatus, UsageStats } from "./types.js";

export interface PiJsonProgressSnapshot {
	output: string;
	usage: UsageStats;
	events: RenderEvent[];
	stopReason?: string;
	error?: string;
}

/** 将 Pi JSON mode 事件归并成可重复读取的 subagent 进度快照。 */
export class PiJsonProgressAccumulator {
	private readonly committedUsage = emptyUsage();
	private liveUsage: UsageStats | undefined;
	private turnOpen = false;
	private output = "";
	private stopReason: string | undefined;
	private error: string | undefined;
	private readonly events: RenderEvent[] = [];
	private messageEventStart: number | undefined;
	private readonly textBlocks = new Map<number, string>();
	private readonly textEventIndexes = new Map<number, number>();
	private readonly toolEventIndexes = new Map<string, number>();

	consume(event: JsonAgentSessionEvent): boolean {
		switch (event.type) {
			case "message_start":
				if (event.message.role !== "assistant") return false;
				this.startTurn();
				return false;
			case "message_update":
				return this.consumeMessageUpdate(event);
			case "message_end":
				if (event.message.role !== "assistant") return false;
				return this.consumeMessageEnd(event.message);
			case "tool_execution_start":
				this.upsertTool(event.toolCallId, event.toolName, toolArgs(event.args), "running");
				return true;
			case "tool_execution_update":
				this.updateTool(event.toolCallId, "running");
				return true;
			case "tool_execution_end":
				this.updateTool(event.toolCallId, event.isError ? "error" : "completed");
				return true;
			default:
				return false;
		}
	}

	snapshot(): PiJsonProgressSnapshot {
		return {
			output: this.output,
			usage: combineUsage(this.committedUsage, this.liveUsage, this.turnOpen),
			events: this.events.map(cloneRenderEvent),
			...(this.stopReason !== undefined ? { stopReason: this.stopReason } : {}),
			...(this.error !== undefined ? { error: this.error } : {}),
		};
	}

	private consumeMessageUpdate(event: Extract<JsonAgentSessionEvent, { type: "message_update" }>): boolean {
		this.requireTurn();
		this.liveUsage = usageStats(event.usage);
		const assistantEvent = event.assistantMessageEvent;
		switch (assistantEvent.type) {
			case "text_start":
				this.startTextBlock(assistantEvent.contentIndex);
				return false;
			case "text_delta":
				this.appendText(assistantEvent.contentIndex, assistantEvent.delta);
				break;
			case "text_end":
				this.setText(assistantEvent.contentIndex, assistantEvent.content);
				break;
			case "toolcall_end":
				this.recordToolCall(assistantEvent.toolCall, "pending");
				break;
		}
		return true;
	}

	private consumeMessageEnd(message: Extract<Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"], { role: "assistant" }>): boolean {
		this.requireTurn();
		this.replaceLiveMessageEvents();
		for (const part of message.content) {
			if (part.type === "text") {
				this.output = part.text;
				this.events.push({ type: "text", text: part.text });
			} else if (part.type === "toolCall") {
				this.recordToolCall(part, "pending");
			}
		}
		this.stopReason = message.stopReason;
		this.error = message.errorMessage;
		commitUsage(this.committedUsage, message.usage);
		this.liveUsage = undefined;
		this.turnOpen = false;
		this.messageEventStart = undefined;
		this.textBlocks.clear();
		this.textEventIndexes.clear();
		return true;
	}

	private startTurn(): void {
		if (this.turnOpen) throw new Error("nested assistant message_start");
		this.turnOpen = true;
		this.liveUsage = undefined;
		this.messageEventStart = this.events.length;
		this.textBlocks.clear();
		this.textEventIndexes.clear();
	}

	private requireTurn(): void {
		if (!this.turnOpen) throw new Error("assistant event arrived before message_start");
	}

	private startTextBlock(contentIndex: number): void {
		if (this.textBlocks.has(contentIndex)) throw new Error(`duplicate text_start for content ${contentIndex}`);
		this.textBlocks.set(contentIndex, "");
	}

	private appendText(contentIndex: number, delta: string): void {
		const current = this.textBlocks.get(contentIndex);
		if (current === undefined) throw new Error(`text_delta arrived before text_start for content ${contentIndex}`);
		this.setText(contentIndex, `${current}${delta}`);
	}

	private setText(contentIndex: number, text: string): void {
		if (!this.textBlocks.has(contentIndex)) throw new Error(`text_end arrived before text_start for content ${contentIndex}`);
		this.textBlocks.set(contentIndex, text);
		this.output = text;
		const eventIndex = this.textEventIndexes.get(contentIndex);
		if (eventIndex === undefined) {
			this.textEventIndexes.set(contentIndex, this.events.length);
			this.events.push({ type: "text", text });
			return;
		}
		this.events[eventIndex] = { type: "text", text };
	}

	private replaceLiveMessageEvents(): void {
		const start = this.messageEventStart;
		if (start === undefined) throw new Error("assistant message has no event boundary");
		this.events.splice(start);
		for (const [id, index] of this.toolEventIndexes) {
			if (index >= start) this.toolEventIndexes.delete(id);
		}
		this.textEventIndexes.clear();
	}

	private recordToolCall(toolCall: { id: string; name: string; arguments: Record<string, unknown> }, status: ToolProgressStatus): void {
		this.upsertTool(toolCall.id, toolCall.name, toolCall.arguments, status);
	}

	private upsertTool(id: string, name: string, args: Record<string, unknown>, status: ToolProgressStatus): void {
		const index = this.toolEventIndexes.get(id);
		if (index === undefined) {
			this.toolEventIndexes.set(id, this.events.length);
			this.events.push({ type: "tool", name, args, status });
			return;
		}
		const current = this.events[index];
		if (current?.type !== "tool") throw new Error(`tool event index is invalid: ${id}`);
		this.events[index] = { type: "tool", name, args, status };
	}

	private updateTool(id: string, status: ToolProgressStatus): void {
		const index = this.toolEventIndexes.get(id);
		if (index === undefined) throw new Error(`tool lifecycle started without a tool call: ${id}`);
		const current = this.events[index];
		if (current?.type !== "tool") throw new Error(`tool event index is invalid: ${id}`);
		this.events[index] = { ...current, status };
	}
}

function usageStats(value: Usage): UsageStats {
	return {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		contextTokens: value.totalTokens,
		turns: 0,
		...(value.cost.total > 0 ? { cost: value.cost.total } : {}),
	};
}

function commitUsage(target: UsageStats, value: Usage): void {
	const usage = usageStats(value);
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.contextTokens = Math.max(target.contextTokens, usage.contextTokens);
	target.turns++;
	if (usage.cost !== undefined) target.cost = (target.cost ?? 0) + usage.cost;
}

function combineUsage(committed: UsageStats, live: UsageStats | undefined, turnOpen: boolean): UsageStats {
	const current = live ?? emptyUsage();
	const cost = (committed.cost ?? 0) + (current.cost ?? 0);
	return {
		input: committed.input + current.input,
		output: committed.output + current.output,
		cacheRead: committed.cacheRead + current.cacheRead,
		cacheWrite: committed.cacheWrite + current.cacheWrite,
		contextTokens: Math.max(committed.contextTokens, current.contextTokens),
		turns: committed.turns + (turnOpen ? 1 : 0),
		...(cost > 0 ? { cost } : {}),
	};
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
}

function cloneRenderEvent(event: RenderEvent): RenderEvent {
	return event.type === "text" ? { ...event } : { ...event, args: { ...event.args } };
}

function toolArgs(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tool arguments must be an object");
	return value as Record<string, unknown>;
}
