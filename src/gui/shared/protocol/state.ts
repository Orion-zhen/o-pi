import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";
import type { AutoTitleState } from "../../../harness/extensions/auto-title.ts";
import type { CodexSpeed } from "../../../harness/codex-speed/state.ts";
import type { UsageSnapshot } from "../../../harness/usage/types.ts";
import type { SubagentDetails } from "../../../harness/subagent/types.ts";
import type { ApprovalUnit } from "../../../harness/approval/types.ts";
import type { GuiEntry, GuiMessage, GuiNestedCalls, GuiToolOutput } from "../messages/types.ts";
import type { GuiToolSelectionItem } from "../config/mcp.ts";
import type { ToolPreset } from "../../../harness/tool-defaults/types.ts";

export const queueModes = ["one-at-a-time", "all"] as const;

export type SessionTarget = { id: string } | { path: string };

export interface GuiBashApproval {
	cwd: string;
	command: string;
	items: { action: ApprovalUnit["action"]; kind: ApprovalUnit["target"]["kind"]; target: string; reason: string }[];
}
export interface GuiDialog {
	id: string;
	kind: "select" | "confirm" | "input" | "editor" | "secret";
	title: string;
	message: string;
	options: string[];
	initial: string;
	deadline: number | null;
	bash?: GuiBashApproval;
}
export interface GuiNotice {
	id: string;
	type: "info" | "warning" | "error";
	text: string;
	/** 到达时时间线已有条目数，用于内联插入位置。 */
	anchor: number;
}
export interface GuiModel {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	thinking: {
		levels: ModelThinkingLevel[];
		resolved: Record<string, ModelThinkingLevel>;
	};
}
export interface GuiWorkspaceInfo {
	path: string;
	exists: boolean;
	home?: { username: string; suffix: string };
}
export interface GuiSessionActivity {
	sessionId: string;
	path: string | null;
	cwd: string;
	/** 仅显式会话名；空串表示未命名，由列表回退到历史派生标题。 */
	title: string;
	titleGeneration?: AutoTitleState;
	state: "loading" | "running" | "waiting" | "idle";
	completedAt: number;
	modified: string;
}
export interface GuiSessionInfo {
	path: string;
	cwd: string;
	title: string;
	modified: string;
}
export interface GuiLiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	output: GuiToolOutput | undefined;
	nestedCalls?: GuiNestedCalls;
	completion?: { isError: boolean; durationMs?: number };
}

export interface GuiSnapshot {
	cwd: string;
	leafId: string | null;
	sessionId: string;
	sessionFile: string | null;
	name: string;
	titleGeneration?: AutoTitleState;
	canSubmit: boolean;
	canChangeSession: boolean;
	running: boolean;
	commandRunning: boolean;
	liveTools: GuiLiveTool[];
	streaming: boolean;
	retrying: boolean;
	compacting: boolean;
	contextEntryIds: string[];
	history: string[];
	streamingMessage: GuiMessage | null;
	entries: GuiEntry[];
	model: GuiModel | null;
	codexSpeed: CodexSpeed | null;
	routedModel: { model: GuiModel; thinkingLevel?: string } | null;
	models: GuiModel[];
	scopedModels: string[];
	modelScopeChanged: boolean;
	modelServicesRevision: number;
	defaultModel: { provider: string | null; id: string | null; thinking: ThinkingLevel | null };
	thinking: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	context: ReturnType<AgentSession["getContextUsage"]> | null;
	stats: SessionStats;
	queue: { steering: readonly string[]; followUp: readonly string[] };
	settings: {
		compaction: boolean;
		retry: boolean;
		steering: typeof queueModes[number];
		followUp: typeof queueModes[number];
		autoResize: boolean;
		blockImages: boolean;
	};
	commands: { name: string; description: string }[];
	tools: (GuiToolSelectionItem & { callable: boolean })[];
	modelTools: string[];
	toolDefaultsChanged: boolean;
	toolPreset: ToolPreset | null;
	providers: { id: string; name: string; apiKey: boolean; oauth: boolean; authenticated: boolean }[];
	bashCommand: string | null;
	bashOutput: string;
}
export type GuiSessionTab = "tree" | "stats" | "telemetry";
export type GuiPanel =
	| { kind: "model" | "tools" | "sessions" | "auth" | "import" | "help" }
	| { kind: "settings"; category?: "mcp" }
	| { kind: "system" | "lastReply"; text: string }
	| { kind: "usage"; value: UsageSnapshot | "aborted" }
	| { kind: "subagents"; details: SubagentDetails };
