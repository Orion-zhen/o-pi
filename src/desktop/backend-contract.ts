import type { FeedbackTone, GuiEvent } from "../gui/shared/protocol/events.ts";
import type { GuiDelivery } from "../gui/shared/protocol/sync.ts";
import type { GuiControl } from "../gui/shared/protocol/connection.ts";

export type BackendCall =
	| { kind: "action" | "query"; value: unknown }
	| { kind: "resource"; token: string }
	| { kind: "activeSessions" };
export type BackendRequest = BackendCall & { id: number; traced: boolean };

export type BackendControl = GuiControl
	| { kind: "subscribe" | "unsubscribe" }
	| { kind: "feedback"; message: string; tone: FeedbackTone };

export type BackendCommand = BackendRequest | BackendControl | { kind: "dispose" };

export type BackendMessage =
	| { kind: "ready" }
	| { kind: "desktopState"; value: Extract<GuiEvent, { type: "activity" | "guiConfig" | "selected" | "workspaces" }> }
	| { kind: "webError"; message: string }
	| { kind: "delivery"; value: GuiDelivery; at: number }
	| { kind: "requestReceived"; id: number; at: number }
	| { kind: "userAvailable"; sessionId: string; userTimestamp: number; at: number }
	| { kind: "result"; id: number; value: unknown }
	| { kind: "error"; id: number; message: string };
