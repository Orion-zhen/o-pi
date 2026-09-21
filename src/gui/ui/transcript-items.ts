import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GuiSnapshot } from "../contract.ts";
import type { replyMetrics } from "../message-metrics.ts";

export type TranscriptSource = Pick<GuiSnapshot, "messages" | "models" | "messageDurations" | "streamingMessage" | "liveTools" | "streaming" | "retrying">;
export type ToolState = "preparing" | "pending" | "running" | "completed" | "failed" | "stopped" | "unavailable";
export interface ToolOutput {
	content: unknown;
	details?: unknown;
}
export interface ToolActivity {
	id: string;
	name: string;
	args: unknown;
	state: ToolState;
	output: ToolOutput | undefined;
}
export type TranscriptItem = { key: string; messageIndex: number } & (
	| { kind: "message"; message: AgentMessage }
	| { kind: "text"; text: string; blockIndex: number; active: boolean;
		identity: { model: string; timestamp: number }; metrics: ReturnType<typeof replyMetrics> }
	| { kind: "thinking"; text: string; active: boolean }
	| { kind: "tool"; tool: ToolActivity; pruned: boolean }
	| { kind: "error"; text: string }
);
