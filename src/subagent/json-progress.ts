import type { RenderEvent, ToolProgressStatus, UsageStats } from "./types.js";

export interface PiJsonProgressSnapshot {
	output: string;
	usage: UsageStats;
	events: RenderEvent[];
	stopReason?: string;
	error?: string;
	wrote: boolean;
}

/** 将 Pi JSON mode 的 delta 事件归并成可安全重复读取的 subagent 进度快照。 */
export class PiJsonProgressAccumulator {
	private readonly committedUsage = emptyUsage();
	private liveUsage: UsageStats | undefined;
	private turnOpen = false;
	private output = "";
	private stopReason: string | undefined;
	private error: string | undefined;
	private wrote = false;
	private readonly events: RenderEvent[] = [];
	private messageEventStart: number | undefined;
	private readonly textBlocks = new Map<number, string>();
	private readonly textEventIndexes = new Map<number, number>();
	private readonly toolEventIndexes = new Map<string, number>();

	consume(event: Record<string, unknown>): boolean {
		switch (stringField(event, "type")) {
			case "message_start":
				return this.consumeMessageStart(recordField(event, "message"));
			case "message_update":
				return this.consumeMessageUpdate(event);
			case "message_end":
				return this.consumeMessageEnd(recordField(event, "message"));
			case "tool_execution_start":
				return this.consumeToolStart(event);
			case "tool_execution_update":
				return this.consumeToolUpdate(event);
			case "tool_execution_end":
				return this.consumeToolEnd(event);
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
			wrote: this.wrote,
		};
	}

	private consumeMessageStart(message: Record<string, unknown> | undefined): boolean {
		if (message === undefined || stringField(message, "role") !== "assistant") return false;
		this.startTurn();
		return false;
	}

	private consumeMessageUpdate(event: Record<string, unknown>): boolean {
		this.ensureTurn();
		const usage = recordField(event, "usage");
		if (usage !== undefined) this.liveUsage = parseUsage(usage);
		const assistantEvent = recordField(event, "assistantMessageEvent");
		if (assistantEvent === undefined) return usage !== undefined;
		const contentIndex = integerField(assistantEvent, "contentIndex");
		switch (stringField(assistantEvent, "type")) {
			case "toolcall_start": {
				const id = stringField(assistantEvent, "id");
				const name = stringField(assistantEvent, "toolName");
				if (id !== undefined && name !== undefined) {
					this.markWrite(name);
					this.upsertTool(id, name, {}, "pending");
				}
				break;
			}
			case "text_start":
				if (contentIndex !== undefined) this.startTextBlock(contentIndex);
				break;
			case "text_delta": {
				const delta = stringField(assistantEvent, "delta");
				if (contentIndex !== undefined && delta !== undefined) this.appendText(contentIndex, delta);
				break;
			}
			case "text_end": {
				const content = stringField(assistantEvent, "content");
				if (contentIndex !== undefined && content !== undefined) this.setText(contentIndex, content);
				break;
			}
			case "toolcall_end": {
				const toolCall = recordField(assistantEvent, "toolCall");
				if (toolCall !== undefined) this.recordToolCall(toolCall, "pending");
				break;
			}
		}
		return true;
	}

	private consumeMessageEnd(message: Record<string, unknown> | undefined): boolean {
		if (message === undefined || stringField(message, "role") !== "assistant") return false;
		this.ensureTurn();
		this.replaceLiveMessageEvents();
		for (const part of contentParts(message)) {
			if (stringField(part, "type") === "text") {
				const text = stringField(part, "text");
				if (text !== undefined) {
					this.output = text;
					this.events.push({ type: "text", text });
				}
				continue;
			}
			if (stringField(part, "type") === "toolCall") this.recordToolCall(part, "pending");
		}
		const reason = stringField(message, "stopReason");
		if (reason !== undefined) this.stopReason = reason;
		const errorMessage = stringField(message, "errorMessage");
		if (errorMessage !== undefined) this.error = errorMessage;
		commitUsage(this.committedUsage, recordField(message, "usage"));
		this.liveUsage = undefined;
		this.turnOpen = false;
		this.messageEventStart = undefined;
		this.textBlocks.clear();
		this.textEventIndexes.clear();
		return true;
	}

	private consumeToolStart(event: Record<string, unknown>): boolean {
		const id = stringField(event, "toolCallId");
		const name = stringField(event, "toolName");
		if (id === undefined || name === undefined) return false;
		this.markWrite(name);
		this.upsertTool(id, name, recordField(event, "args") ?? {}, "running");
		return true;
	}

	private consumeToolUpdate(event: Record<string, unknown>): boolean {
		const id = stringField(event, "toolCallId");
		const name = stringField(event, "toolName");
		if (id === undefined || name === undefined) return false;
		this.markWrite(name);
		const index = this.toolEventIndexes.get(id);
		if (index === undefined) {
			this.upsertTool(id, name, recordField(event, "args") ?? {}, "running");
			return true;
		}
		const current = this.events[index];
		if (current?.type !== "tool" || current.status === "running") return false;
		this.events[index] = { ...current, status: "running" };
		return true;
	}

	private consumeToolEnd(event: Record<string, unknown>): boolean {
		const id = stringField(event, "toolCallId");
		const name = stringField(event, "toolName");
		if (id === undefined || name === undefined) return false;
		this.markWrite(name);
		this.upsertTool(id, name, recordField(event, "args") ?? {}, booleanField(event, "isError") ? "error" : "completed");
		return true;
	}

	private startTurn(): void {
		this.turnOpen = true;
		this.liveUsage = undefined;
		this.messageEventStart = this.events.length;
		this.textBlocks.clear();
		this.textEventIndexes.clear();
	}

	private ensureTurn(): void {
		if (!this.turnOpen) this.startTurn();
	}

	private startTextBlock(contentIndex: number): void {
		if (!this.textBlocks.has(contentIndex)) this.textBlocks.set(contentIndex, "");
	}

	private appendText(contentIndex: number, delta: string): void {
		this.setText(contentIndex, `${this.textBlocks.get(contentIndex) ?? ""}${delta}`);
	}

	private setText(contentIndex: number, text: string): void {
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
		if (start === undefined) return;
		this.events.splice(start);
		for (const [id, index] of this.toolEventIndexes) {
			if (index >= start) this.toolEventIndexes.delete(id);
		}
		this.textEventIndexes.clear();
	}

	private recordToolCall(toolCall: Record<string, unknown>, status: ToolProgressStatus): void {
		const name = stringField(toolCall, "name") ?? "tool";
		const id = stringField(toolCall, "id");
		const args = recordField(toolCall, "arguments") ?? {};
		this.markWrite(name);
		if (id === undefined) {
			this.events.push({ type: "tool", name, args, status });
			return;
		}
		this.upsertTool(id, name, args, status);
	}

	private upsertTool(id: string, name: string, args: Record<string, unknown>, status: ToolProgressStatus): void {
		const index = this.toolEventIndexes.get(id);
		if (index === undefined) {
			this.toolEventIndexes.set(id, this.events.length);
			this.events.push({ type: "tool", name, args, status });
			return;
		}
		const current = this.events[index];
		this.events[index] = current?.type === "tool"
			? { type: "tool", name, args: Object.keys(args).length > 0 ? args : current.args, status }
			: { type: "tool", name, args, status };
	}

	private markWrite(name: string): void {
		if (name === "write" || name === "edit" || name === "bash") this.wrote = true;
	}
}

function contentParts(message: Record<string, unknown>): Record<string, unknown>[] {
	const content = message["content"];
	if (!Array.isArray(content)) return [];
	return content.filter(isRecord);
}

function parseUsage(value: Record<string, unknown>): UsageStats {
	const cost = recordField(value, "cost");
	const totalCost = cost === undefined ? undefined : numberField(cost, "total");
	return {
		input: numberField(value, "input"),
		output: numberField(value, "output"),
		cacheRead: numberField(value, "cacheRead"),
		cacheWrite: numberField(value, "cacheWrite"),
		contextTokens: numberField(value, "totalTokens"),
		turns: 0,
		...(totalCost !== undefined && totalCost > 0 ? { cost: totalCost } : {}),
	};
}

function commitUsage(target: UsageStats, value: Record<string, unknown> | undefined): void {
	const usage = value === undefined ? emptyUsage() : parseUsage(value);
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

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function integerField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
	return record[key] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
