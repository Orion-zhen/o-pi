import type { Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RenderEvent, ToolProgressStatus, UsageStats } from "./types.ts";

export interface PiJsonProgressSnapshot {
	output: string;
	usage: UsageStats;
	events: RenderEvent[];
	stopReason?: string;
	error?: string;
	wrote: boolean;
}

interface AssistantTurn {
	start: number;
	usage: UsageStats;
	textBlocks: Map<number, string>;
	textEvents: Map<number, Extract<RenderEvent, { type: "text" }>>;
	toolIds: Set<string>;
}

/** 将 Pi JSON mode 事件归并成可重复读取的 subagent 进度快照。 */
export class PiJsonProgressAccumulator {
	private readonly committedUsage = emptyUsage();
	private turn: AssistantTurn | undefined;
	private output = "";
	private stopReason: string | undefined;
	private error: string | undefined;
	private wrote = false;
	private readonly events: RenderEvent[] = [];
	private readonly tools = new Map<string, Extract<RenderEvent, { type: "tool" }>>();

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
				this.markWrite(event.toolName);
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
			usage: combineUsage(this.committedUsage, this.turn),
			events: this.events.map(cloneRenderEvent),
			...(this.stopReason !== undefined ? { stopReason: this.stopReason } : {}),
			...(this.error !== undefined ? { error: this.error } : {}),
			wrote: this.wrote,
		};
	}

	private consumeMessageUpdate(event: Extract<JsonAgentSessionEvent, { type: "message_update" }>): boolean {
		const turn = this.requireTurn();
		turn.usage = usageStats(event.usage);
		const assistantEvent = event.assistantMessageEvent;
		switch (assistantEvent.type) {
			case "toolcall_start":
				this.markWrite(assistantEvent.toolName);
				this.upsertTool(assistantEvent.id, assistantEvent.toolName, {}, "pending");
				break;
			case "text_start":
				this.startTextBlock(turn, assistantEvent.contentIndex);
				return false;
			case "text_delta":
			case "text_end": {
				const { contentIndex } = assistantEvent;
				const previous = turn.textBlocks.get(contentIndex);
				if (previous === undefined) throw new Error(`${assistantEvent.type} arrived before text_start for content ${contentIndex}`);
				this.setText(turn, contentIndex, assistantEvent.type === "text_delta" ? previous + assistantEvent.delta : assistantEvent.content);
				break;
			}
			case "toolcall_end":
				this.recordToolCall(assistantEvent.toolCall, "pending");
				break;
		}
		return true;
	}

	private consumeMessageEnd(message: Extract<Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"], { role: "assistant" }>): boolean {
		const turn = this.requireTurn();
		this.events.splice(turn.start);
		for (const id of turn.toolIds) this.tools.delete(id);
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
		this.turn = undefined;
		return true;
	}

	private startTurn(): void {
		if (this.turn !== undefined) throw new Error("nested assistant message_start");
		this.turn = {
			start: this.events.length,
			usage: emptyUsage(),
			textBlocks: new Map(),
			textEvents: new Map(),
			toolIds: new Set(),
		};
	}

	private requireTurn(): AssistantTurn {
		if (this.turn === undefined) throw new Error("assistant event arrived before message_start");
		return this.turn;
	}

	private startTextBlock(turn: AssistantTurn, contentIndex: number): void {
		if (turn.textBlocks.has(contentIndex)) throw new Error(`duplicate text_start for content ${contentIndex}`);
		turn.textBlocks.set(contentIndex, "");
	}

	private setText(turn: AssistantTurn, contentIndex: number, text: string): void {
		turn.textBlocks.set(contentIndex, text);
		this.output = text;
		const current = turn.textEvents.get(contentIndex);
		if (current === undefined) {
			const event = { type: "text" as const, text };
			turn.textEvents.set(contentIndex, event);
			this.events.push(event);
		} else current.text = text;
	}

	private recordToolCall(toolCall: { id: string; name: string; arguments: Record<string, unknown> }, status: ToolProgressStatus): void {
		this.markWrite(toolCall.name);
		this.upsertTool(toolCall.id, toolCall.name, toolCall.arguments, status);
	}

	private upsertTool(id: string, name: string, args: Record<string, unknown>, status: ToolProgressStatus): void {
		const current = this.tools.get(id);
		if (current === undefined) {
			const event = { type: "tool" as const, name, args, status };
			this.turn?.toolIds.add(id);
			this.tools.set(id, event);
			this.events.push(event);
		} else Object.assign(current, { name, args, status });
	}

	private updateTool(id: string, status: ToolProgressStatus): void {
		const current = this.tools.get(id);
		if (current === undefined) throw new Error(`tool lifecycle started without a tool call: ${id}`);
		current.status = status;
	}

	private markWrite(name: string): void {
		if (name === "write" || name === "edit" || name === "bash") this.wrote = true;
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
		costFromProvider: value.cost.totalFromProvider === true,
		...(value.cost.total > 0 || value.cost.totalFromProvider === true ? { cost: value.cost.total } : {}),
	};
}

function commitUsage(target: UsageStats, value: Usage): void {
	const usage = usageStats(value);
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.contextTokens = Math.max(target.contextTokens, usage.contextTokens);
	target.costFromProvider = (target.turns === 0 || target.costFromProvider === true) && usage.costFromProvider === true;
	target.turns++;
	if (usage.cost !== undefined) target.cost = (target.cost ?? 0) + usage.cost;
}

function combineUsage(committed: UsageStats, turn: AssistantTurn | undefined): UsageStats {
	const current = turn?.usage ?? emptyUsage();
	const cost = (committed.cost ?? 0) + (current.cost ?? 0);
	return {
		input: committed.input + current.input,
		output: committed.output + current.output,
		cacheRead: committed.cacheRead + current.cacheRead,
		cacheWrite: committed.cacheWrite + current.cacheWrite,
		contextTokens: Math.max(committed.contextTokens, current.contextTokens),
		turns: committed.turns + (turn === undefined ? 0 : 1),
		...(committed.turns > 0 || turn !== undefined ? {
			costFromProvider: (committed.turns === 0 || committed.costFromProvider === true)
				&& (turn === undefined || current.costFromProvider === true),
		} : {}),
		...(committed.cost !== undefined || current.cost !== undefined ? { cost } : {}),
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
