import { Type, type Static, type TProperties } from "typebox";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ToolSelectionItem } from "../harness/tool-defaults/controller.ts";
import type { StatsSnapshot } from "../harness/stats/types.ts";
import type { UsageSnapshot } from "../harness/usage/types.ts";
import type { LiveTelemetryReport } from "../harness/telemetry-report/live.ts";
import type { SubagentDetails } from "../harness/subagent/types.ts";
import type { FilePreview, WorkspaceEntry, WorkspaceGit } from "./workbench.ts";
import type { GuiConfigDocument } from "./preferences.ts";

const text = Type.String({ maxLength: 4_000_000 });
const short = Type.String({ maxLength: 4096 });
const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const image = object({
	data: text,
	mimeType: Type.Union([
		Type.Literal("image/png"),
		Type.Literal("image/jpeg"),
		Type.Literal("image/webp"),
		Type.Literal("image/gif"),
	]),
});

/** 只定义跨进程操作参数，不另建 Agent 或会话状态机。 */
export const actionSchema = Type.Union([
	object({
		action: Type.Literal("prompt"),
		text,
		images: Type.Array(image, { maxItems: 8 }),
		behavior: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
	}),
	object({
		action: Type.Union([
			Type.Literal("abort"),
			Type.Literal("new"),
			Type.Literal("reload"),
			Type.Literal("sessions"),
			Type.Literal("clearQueue"),
			Type.Literal("persistTools"),
			Type.Literal("persistModels"),
			Type.Literal("cancelLogin"),
		]),
	}),
	object({
		action: Type.Literal("view"),
		view: Type.Union([Type.Literal("usage"), Type.Literal("system")]),
	}),
	object({ action: Type.Literal("workspace"), path: short }),
	object({ action: Type.Literal("removeWorkspace"), path: short }),
	object({ action: Type.Literal("switch"), path: short }),
	object({ action: Type.Literal("renameSession"), path: short, name: short }),
	object({ action: Type.Literal("deleteSession"), path: short }),
	object({ action: Type.Literal("fork"), entryId: short }),
	object({ action: Type.Literal("navigate"), entryId: short, summarize: Type.Boolean() }),
	object({ action: Type.Literal("label"), entryId: short, label: short }),
	object({ action: Type.Literal("rename"), name: short }),
	object({ action: Type.Literal("import"), content: text }),
	object({ action: Type.Literal("export"), format: Type.Union([Type.Literal("jsonl"), Type.Literal("html")]) }),
	object({ action: Type.Literal("model"), provider: short, id: short }),
	object({
		action: Type.Literal("thinking"),
		level: Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		]),
	}),
	object({ action: Type.Literal("scopeModels"), models: Type.Array(short, { maxItems: 1000, uniqueItems: true }) }),
	object({
		action: Type.Literal("settings"),
		compaction: Type.Boolean(),
		retry: Type.Boolean(),
		steering: Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]),
		followUp: Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]),
		autoResize: Type.Boolean(),
		blockImages: Type.Boolean(),
	}),
	object({ action: Type.Literal("compact"), instructions: short }),
	object({
		action: Type.Literal("login"),
		provider: short,
		type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
	}),
	object({ action: Type.Literal("logout"), provider: short }),
	object({ action: Type.Literal("tool"), name: short, enabled: Type.Boolean() }),
	object({ action: Type.Literal("dialog"), id: short, value: Type.Union([text, Type.Null()]) }),
	object({ action: Type.Literal("draft"), text }),
	object({ action: Type.Literal("saveGuiConfig"), original: text, content: text }),
	object({ action: Type.Literal("saveConfig"), file: Type.Literal("settings.json"), original: text, content: text }),
]);
export type GuiAction = Static<typeof actionSchema>;

export const querySchema = Type.Union([
	object({ query: Type.Literal("guiConfig") }),
	object({ query: Type.Literal("directories"), path: short }),
	object({ query: Type.Literal("files"), prefix: short }),
	object({ query: Type.Literal("workspaceFiles"), cwd: short, path: short }),
	object({ query: Type.Literal("workspaceGit"), cwd: short }),
	object({ query: Type.Literal("previewFile"), cwd: short, path: short }),
	object({ query: Type.Literal("complete"), text: short }),
	object({ query: Type.Literal("config"), file: Type.Literal("settings.json") }),
]);
export type GuiQuery = Static<typeof querySchema>;
export interface GuiQueryResults {
	guiConfig: GuiConfigDocument;
	directories: GuiDirectories;
	files: string[];
	workspaceFiles: WorkspaceEntry[];
	workspaceGit: WorkspaceGit | null;
	previewFile: FilePreview;
	complete: { value: string; label: string; description?: string }[];
	config: string;
}
export type Query = <Q extends GuiQuery>(query: Q) => Promise<GuiQueryResults[Q["query"]]>;

export interface GuiDialog {
	id: string;
	kind: "select" | "confirm" | "input" | "editor" | "secret";
	title: string;
	message: string;
	options: string[];
	initial: string;
	deadline: number | null;
}
export interface GuiNotice {
	id: string;
	type: "info" | "warning" | "error";
	text: string;
}
export interface GuiModel {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
}
export interface GuiWorkspaceInfo {
	path: string;
	exists: boolean;
}
export interface GuiSessionInfo {
	path: string;
	cwd: string;
	title: string;
	modified: string;
}
export interface GuiSnapshot {
	cwd: string;
	leafId: string | null;
	sessionId: string;
	sessionFile: string | null;
	name: string;
	canSubmit: boolean;
	canChangeSession: boolean;
	running: boolean;
	commandRunning: boolean;
	liveTools: Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" }>[];
	streaming: boolean;
	retrying: boolean;
	messages: AgentMessage[];
	history: string[];
	streamingMessage: AgentMessage | null;
	messageDurations: Record<string, number>;
	entries: SessionEntry[];
	model: GuiModel | null;
	models: GuiModel[];
	scopedModels: string[];
	thinking: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	context: ReturnType<AgentSession["getContextUsage"]> | null;
	stats: SessionStats;
	queue: { steering: readonly string[]; followUp: readonly string[] };
	settings: {
		compaction: boolean;
		retry: boolean;
		steering: "all" | "one-at-a-time";
		followUp: "all" | "one-at-a-time";
		autoResize: boolean;
		blockImages: boolean;
	};
	commands: { name: string; description: string }[];
	tools: ToolSelectionItem[];
	providers: { id: string; name: string; oauth: boolean; authenticated: boolean }[];
	status: Record<string, string>;
}
export type GuiSessionTab = "tree" | "stats" | "telemetry";
export type GuiPanel =
	| { kind: "model" | "tools" | "sessions" | "auth" | "import" | "help" }
	| { kind: "settings" }
	| { kind: "system" | "lastReply"; text: string }
	| { kind: "usage"; value: UsageSnapshot | "aborted" }
	| { kind: "subagents"; details: SubagentDetails };

export interface GuiSessionDetails {
	sessionId: string;
	tree: import("@earendil-works/pi-coding-agent").SessionTreeNode[];
	stats: StatsSnapshot;
	telemetry: LiveTelemetryReport;
}
export interface GuiDirectories {
	path: string;
	parent: string;
	children: { name: string; path: string }[];
}

export type GuiEvent =
	| { type: "guiConfig"; value: GuiConfigDocument }
	| { type: "workspaceRoot"; path: string }
	| { type: "sessionInfo"; value: GuiSessionDetails }
	| { type: "sessionTab"; tab: GuiSessionTab }
	| { type: "snapshot"; value: GuiSnapshot | null }
	| { type: "sessions"; value: GuiSessionInfo[] }
	| { type: "workspaces"; value: GuiWorkspaceInfo[] }
	| { type: "dialogs"; value: GuiDialog[] }
	| { type: "notice"; value: GuiNotice }
	| { type: "panel"; panel: GuiPanel }
	| { type: "editor"; text: string }
	| { type: "download"; name: string; content: string; mimeType: string }
	| { type: "auth"; value: import("@earendil-works/pi-ai").AuthEvent }
	| { type: "close" };

export interface GuiConnection {
	send(action: GuiAction): Promise<void>;
	query: Query;
	subscribe(listener: (event: GuiEvent) => void): () => void;
	close(): void;
}
export interface DesktopBridge extends GuiConnection {
	chooseDirectory(): Promise<string | null>;
	openExternal(url: string): Promise<void>;
}
