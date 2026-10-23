import type { GuiEvent } from "../gui/shared/protocol/events.ts";
import type { GuiDelivery } from "../gui/shared/protocol/sync.ts";
import type { GuiControl } from "../gui/shared/protocol/connection.ts";

export type BackendRequest = { kind: "action" | "query" | "resource" | "activeSessions"; id: number; value: unknown; traced: boolean };

export type BackendControl = GuiControl
	| { kind: "subscribe" | "unsubscribe" }
	| { kind: "notice"; text: string };

export type BackendCommand = BackendRequest | BackendControl | { kind: "dispose" };

export type DesktopStateEvent = Extract<GuiEvent, { type: "activity" | "guiConfig" | "selected" | "workspaces" }>;

export type BackendMessage =
	| { kind: "ready" }
	| { kind: "desktopState"; value: DesktopStateEvent }
	| { kind: "webError"; message: string }
	| { kind: "delivery"; value: GuiDelivery; at: number }
	| { kind: "requestReceived"; id: number; at: number }
	| { kind: "userAvailable"; sessionId: string; userTimestamp: number; at: number }
	| { kind: "result"; id: number; value: unknown }
	| { kind: "error"; id: number; message: string };
