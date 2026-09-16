import { Type, type Static, type TProperties } from "typebox";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ToolSelectionItem } from "../harness/tool-defaults/controller.ts";

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
			Type.Literal("tree"),
			Type.Literal("sessionInfo"),
			Type.Literal("clearQueue"),
			Type.Literal("persistTools"),
			Type.Literal("persistModels"),
			Type.Literal("cancelLogin"),
		]),
	}),
	object({
		action: Type.Literal("view"),
		view: Type.Union([
			Type.Literal("stats"), Type.Literal("usage"), Type.Literal("telemetry"),
			Type.Literal("system"), Type.Literal("tools"),
			Type.Literal("model"), Type.Literal("settings"), Type.Literal("auth"),
			Type.Literal("help"), Type.Literal("import"),
		]),
	}),
	object({ action: Type.Literal("workspace"), path: short }),
	object({ action: Type.Literal("removeWorkspace"), path: short }),
	object({ action: Type.Literal("switch"), path: short }),
	object({ action: Type.Literal("directories"), path: short }),
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
	object({ action: Type.Literal("files"), prefix: short }),
	object({ action: Type.Literal("complete"), text: short }),
	object({ action: Type.Literal("config"), file: Type.Literal("settings.json") }),
	object({ action: Type.Literal("saveConfig"), file: Type.Literal("settings.json"), original: text, content: text }),
]);
export type GuiAction = Static<typeof actionSchema>;

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
	busy: boolean;
	commandRunning: boolean;
	liveTools: Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" }>[];
	streaming: boolean;
	compacting: boolean;
	retrying: boolean;
	bashRunning: boolean;
	messages: AgentMessage[];
	history: string[];
	streamingMessage: AgentMessage | null;
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
	dialogs: GuiDialog[];
	notices: GuiNotice[];
	status: Record<string, string>;
}
export type GuiReport =
	| { title: "会话统计"; value: import("../harness/stats/types.ts").StatsSnapshot }
	| { title: "套餐用量"; value: import("../harness/usage/types.ts").UsageSnapshot | "aborted" }
	| { title: "遥测"; value: import("../harness/telemetry-report/live.ts").LiveTelemetryReport };

export interface GuiSessionDetails {
	sessionId: string;
	tree: import("@earendil-works/pi-coding-agent").SessionTreeNode[];
	stats: import("../harness/stats/types.ts").StatsSnapshot;
	telemetry: import("../harness/telemetry-report/live.ts").LiveTelemetryReport;
}
export interface GuiDirectories {
	path: string;
	parent: string;
	children: { name: string; path: string }[];
}

export type GuiEvent =
	| { type: "workspaceRoot"; path: string }
	| { type: "directories"; value: GuiDirectories }
	| { type: "sessionInfo"; value: GuiSessionDetails }
	| ({ type: "report" } & GuiReport)
	| { type: "snapshot"; value: GuiSnapshot | null }
	| { type: "sessions"; value: GuiSessionInfo[] }
	| { type: "workspaces"; value: GuiWorkspaceInfo[] }
	| { type: "dialogs"; value: GuiDialog[] }
	| { type: "notice"; value: GuiNotice }
	| { type: "panel"; title: string; value: unknown }
	| { type: "editor"; text: string }
	| { type: "files"; paths: string[] }
	| { type: "completions"; text: string; items: { value: string; label: string; description?: string }[] }
	| { type: "download"; name: string; content: string; mimeType: string }
	| { type: "config"; file: "settings.json"; content: string }
	| { type: "auth"; value: import("@earendil-works/pi-ai").AuthEvent }
	| { type: "close" };

export interface GuiConnection {
	send(action: GuiAction): Promise<void>;
	subscribe(listener: (event: GuiEvent) => void): () => void;
	close(): void;
}
export interface DesktopBridge extends GuiConnection {
	chooseDirectory(): Promise<string | null>;
	openExternal(url: string): Promise<void>;
}
