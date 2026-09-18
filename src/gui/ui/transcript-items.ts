import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GuiSnapshot } from "../contract.ts";

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
	| { kind: "text"; text: string; blockIndex: number; active: boolean }
	| { kind: "thinking"; text: string; active: boolean }
	| { kind: "tool"; tool: ToolActivity }
	| { kind: "error"; text: string }
);
