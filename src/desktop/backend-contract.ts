import type { GuiDelivery } from "../gui/sync.ts";
import type { GuiControl } from "../gui/contract.ts";

export type BackendRequest = { kind: "action" | "query" | "resource" | "activeSessions"; id: number; value: unknown; traced: boolean };

export type BackendControl = GuiControl
	| { kind: "subscribe" | "unsubscribe" }
	| { kind: "notice"; text: string };

export type BackendCommand = BackendRequest | BackendControl | { kind: "dispose" };

export type BackendMessage =
	| { kind: "webError"; message: string }
	| { kind: "delivery"; value: GuiDelivery; at: number }
	| { kind: "requestReceived"; id: number; at: number }
	| { kind: "userAvailable"; sessionId: string; userTimestamp: number; at: number }
	| { kind: "result"; id: number; value: unknown }
	| { kind: "error"; id: number; message: string };
