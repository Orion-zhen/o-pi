import type { NestedToolCalls } from "@earendil-works/pi-ai";
import type { GuiMessage, GuiToolOutput } from "../messages.ts";
import type { GuiSnapshot } from "../contract.ts";
import type { replyMetrics } from "../message-metrics.ts";

export type TranscriptSource = Pick<GuiSnapshot, "models" | "messageDurations" | "streamingMessage" | "liveTools" | "streaming" | "retrying"> & { messages: GuiMessage[] };
export type ToolState = "preparing" | "pending" | "running" | "completed" | "failed" | "stopped" | "unavailable";
export interface ToolActivity {
	id: string;
	name: string;
	args: unknown;
	state: ToolState;
	output: GuiToolOutput | undefined;
	nestedCalls?: NestedToolCalls;
}
export type TranscriptItem = { key: string; messageIndex: number } & (
	| { kind: "message"; message: GuiMessage }
	| { kind: "text"; text: string; blockIndex: number; active: boolean;
		identity: { model: string; timestamp: number }; metrics: ReturnType<typeof replyMetrics> }
	| { kind: "thinking"; text: string; active: boolean }
	| { kind: "tool"; tool: ToolActivity; pruned: boolean }
	| { kind: "error"; text: string }
);
