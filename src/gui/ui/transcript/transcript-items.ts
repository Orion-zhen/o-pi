import type { GuiMessage, GuiNestedCalls, GuiToolOutput } from "../../messages.ts";
import type { GuiSnapshot } from "../../contract.ts";
import type { replyMetrics } from "../../message-metrics.ts";

export type TranscriptSource = Pick<GuiSnapshot, "models" | "messageDurations" | "streamingMessage" | "liveTools" | "streaming" | "retrying"> & { messages: GuiMessage[] };
export type ToolState = "preparing" | "pending" | "running" | "completed" | "failed" | "stopped" | "unavailable";
export interface ToolActivity {
	id: string;
	name: string;
	args: unknown;
	state: ToolState;
	output: GuiToolOutput | undefined;
	nestedCalls?: GuiNestedCalls;
	durationMs?: number;
}
export type TranscriptItem = { key: string; messageIndex: number } & (
	| { kind: "message"; message: GuiMessage }
	| { kind: "text"; text: string; blockIndex: number; active: boolean;
		identity: { model: string; timestamp: number }; metrics: ReturnType<typeof replyMetrics> }
	| { kind: "thinking"; text: string; active: boolean }
	| { kind: "tool"; tool: ToolActivity; pruned: boolean }
	| { kind: "error"; text: string }
);

export function sameToolActivity(before: ToolActivity, after: ToolActivity): boolean {
	return before.id === after.id && before.name === after.name && before.state === after.state
		&& before.args === after.args && before.output === after.output && before.nestedCalls === after.nestedCalls && before.durationMs === after.durationMs;
}

/** 投影会重建包装对象，渲染只比较展示字段。正文、参数和结果沿用协议中的不可变引用。 */
export function sameTranscriptItem(before: TranscriptItem, after: TranscriptItem): boolean {
	if (before === after) return true;
	if (before.key !== after.key || before.messageIndex !== after.messageIndex) return false;
	switch (before.kind) {
		case "message": return after.kind === "message" && before.message === after.message;
		case "thinking": return after.kind === "thinking" && before.text === after.text && before.active === after.active;
		case "error": return after.kind === "error" && before.text === after.text;
		case "tool": return after.kind === "tool" && before.pruned === after.pruned && sameToolActivity(before.tool, after.tool);
		case "text": return after.kind === "text" && before.text === after.text && before.active === after.active && before.blockIndex === after.blockIndex
			&& before.identity.model === after.identity.model && before.identity.timestamp === after.identity.timestamp
			&& before.metrics.input === after.metrics.input && before.metrics.output === after.metrics.output
			&& before.metrics.cacheRead === after.metrics.cacheRead && before.metrics.cacheWrite === after.metrics.cacheWrite
			&& before.metrics.cost === after.metrics.cost && before.metrics.speed === after.metrics.speed;
	}
}
