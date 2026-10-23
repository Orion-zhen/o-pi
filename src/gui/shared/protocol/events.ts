import type { Attention } from "../../../harness/attention.ts";
import type { StatsSnapshot } from "../../../harness/stats/types.ts";
import type { LiveTelemetryReport } from "../../../harness/telemetry-report/live.ts";
import type { GuiConfigDocument } from "../config/preferences.ts";
import type { GuiSessionActivity, GuiSessionTab, GuiSnapshot, GuiSessionInfo, GuiWorkspaceInfo, GuiDialog, GuiNotice, GuiPanel } from "./state.ts";

export type GuiEvent =
	| { type: "notification"; value: Attention }
	| { type: "client"; id: string }
	| { type: "selected"; session: { id: string; cwd: string; path: string | null } | null; draftFrom?: string }
	| { type: "activity"; value: GuiSessionActivity[] }
	| { type: "sessionsDeleted"; ids: string[]; paths: string[] }
	| { type: "error"; message: string }
	| { type: "guiConfig"; value: GuiConfigDocument }
	| { type: "workspaceRoot"; path: string }
	| { type: "sessionStats"; sessionId: string; value: StatsSnapshot }
	| { type: "telemetry"; sessionId: string; value: LiveTelemetryReport }
	| { type: "sessionTab"; tab: GuiSessionTab }
	| { type: "snapshot"; value: GuiSnapshot | null }
	// appendOnly 标记相对上次投影的纯追加，不进入传输协议。
	| { type: "stream"; sessionId: string; value: GuiSnapshot["streamingMessage"]; appendOnly: boolean }
	| { type: "sessions"; value: GuiSessionInfo[] }
	| { type: "workspaces"; value: GuiWorkspaceInfo[] }
	| { type: "dialogs"; value: GuiDialog[] }
	| { type: "notices"; value: GuiNotice[] }
	| { type: "panel"; panel: GuiPanel }
	| { type: "editor"; sessionId: string; text: string; mode: "replace" | "prepend" }
	| { type: "download"; name: string; content: string; mimeType: string }
	| { type: "auth"; value: import("@earendil-works/pi-ai").AuthEvent | null }
	| { type: "close" };
