import { Type, type Static, type TProperties } from "typebox";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ToolSelectionItem } from "../harness/tool-defaults/controller.ts";
import type { StatsSnapshot } from "../harness/stats/types.ts";
import type { UsageSnapshot } from "../harness/usage/types.ts";
import type { LiveTelemetryReport } from "../harness/telemetry-report/live.ts";
import type { SubagentDetails } from "../harness/subagent/types.ts";
import type { ApprovalUnit } from "../harness/approval/types.ts";
import type { FilePreview, WorkspaceEntry, WorkspaceGit } from "./workbench.ts";
import type { GuiConfigDocument } from "./preferences.ts";

import { moduleConfigIds, type ModuleConfigDocument } from "./module-config.ts";

const moduleConfigId = Type.Enum(moduleConfigIds);
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

/** 跨进程操作参数，目标会话由请求外层明确指定。 */
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
	object({ action: Type.Literal("openSession"), path: short }),
	object({ action: Type.Literal("openSession"), id: short }),
	object({ action: Type.Literal("observe"), visible: Type.Boolean() }),
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
	object({ action: Type.Literal("clearNotices"), ids: Type.Array(short, { maxItems: 100, uniqueItems: true }) }),
	object({ action: Type.Literal("draft"), text }),
	object({ action: Type.Literal("saveModuleConfig"), id: moduleConfigId, original: text, content: text }),
	object({ action: Type.Literal("saveGuiConfig"), original: text, content: text }),
	object({ action: Type.Literal("saveConfig"), file: Type.Literal("settings.json"), original: text, content: text }),
]);
export type GuiAction = Static<typeof actionSchema>;
export type SessionTarget = { id: string } | { path: string };
export const requestSchema = object({ sessionId: Type.Union([short, Type.Null()]), value: Type.Unknown() });
export type GuiRequest = Static<typeof requestSchema>;

export const querySchema = Type.Union([
	object({ query: Type.Literal("moduleConfig"), id: moduleConfigId }),
	object({ query: Type.Literal("guiConfig") }),
	object({ query: Type.Literal("image"), id: short }),
	object({ query: Type.Literal("toolOutput"), id: short }),
	object({ query: Type.Literal("directories"), path: short }),
	object({ query: Type.Literal("files"), prefix: short }),
	object({ query: Type.Literal("workspaceFiles"), cwd: short, path: short }),
	object({ query: Type.Literal("workspaceGit"), cwd: short }),
	object({ query: Type.Literal("previewFile"), cwd: short, path: short }),
	object({ query: Type.Literal("complete"), text: short }),
	object({ query: Type.Literal("config"), file: Type.Literal("settings.json") }),
]);
export type GuiQuery = Static<typeof querySchema>;
export type GlobalQuery = Extract<GuiQuery, { query: "guiConfig" | "moduleConfig" | "directories" }>;
export type WorkspaceQuery = Extract<GuiQuery, { query: "workspaceFiles" | "workspaceGit" | "previewFile" }>;
export type SessionQuery = Exclude<GuiQuery, GlobalQuery | WorkspaceQuery>;
export interface GuiQueryResults {
	moduleConfig: ModuleConfigDocument;
	guiConfig: GuiConfigDocument;
	image: string;
	toolOutput: { content: unknown; details?: unknown };
	directories: GuiDirectories;
	files: string[];
	workspaceFiles: WorkspaceEntry[];
	workspaceGit: WorkspaceGit | null;
	previewFile: FilePreview;
	complete: { value: string; label: string; description?: string }[];
	config: string;
}
export type Query<T extends GuiQuery = GuiQuery> = <Q extends T>(query: Q) => Promise<GuiQueryResults[Q["query"]]>;

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
}
export interface GuiWorkspaceInfo {
	path: string;
	exists: boolean;
}
export interface GuiSessionActivity {
	sessionId: string;
	path: string | null;
	cwd: string;
	/** 仅显式会话名；空串表示未命名，由列表回退到历史派生标题。 */
	title: string;
	state: "loading" | "running" | "waiting" | "idle";
	completedAt: number;
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
	| { type: "client"; id: string }
	| { type: "selected"; session: { id: string; cwd: string; path: string | null } | null }
	| { type: "activity"; value: GuiSessionActivity[] }
	| { type: "sessionsDeleted"; ids: string[]; paths: string[] }
	| { type: "error"; message: string }
	| { type: "guiConfig"; value: GuiConfigDocument }
	| { type: "workspaceRoot"; path: string }
	| { type: "sessionInfo"; value: GuiSessionDetails }
	| { type: "sessionTab"; tab: GuiSessionTab }
	| { type: "snapshot"; value: GuiSnapshot | null }
	| { type: "stream"; sessionId: string; value: GuiSnapshot["streamingMessage"] }
	| { type: "sessions"; value: GuiSessionInfo[] }
	| { type: "workspaces"; value: GuiWorkspaceInfo[] }
	| { type: "dialogs"; value: GuiDialog[] }
	| { type: "notices"; value: GuiNotice[] }
	| { type: "panel"; panel: GuiPanel }
	| { type: "editor"; sessionId: string; text: string }
	| { type: "download"; name: string; content: string; mimeType: string }
	| { type: "auth"; value: import("@earendil-works/pi-ai").AuthEvent | null }
	| { type: "close" };

export interface GuiConnection {
	send(action: GuiAction, sessionId: string | null): Promise<void>;
	query<Q extends GuiQuery>(query: Q, sessionId: string | null): Promise<GuiQueryResults[Q["query"]]>;
	subscribe(listener: (event: GuiEvent) => void): () => void;
	close(): void;
}
export interface DesktopBridge extends Omit<GuiConnection, "subscribe"> {
	subscribe(listener: (delivery: import("./sync.ts").GuiDelivery) => void): () => void;
	acknowledge(id: number): void;
	chooseDirectory(): Promise<string | null>;
	openExternal(url: string): Promise<void>;
}
