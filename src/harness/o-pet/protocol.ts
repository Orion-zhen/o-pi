export type OPetOutcome = "success" | "error" | "aborted";

export type OPetEvent =
	| { type: "agent_started" }
	| { type: "turn_started" }
	| { type: "thinking_started" }
	| { type: "reply_started" }
	| { type: "reply_finished" }
	| { type: "tool_observed"; toolName: string }
	| { type: "tool_started"; toolCallId: string; toolName: string }
	| { type: "tool_progressed"; toolCallId: string }
	| { type: "tool_finished"; toolCallId: string; outcome: "success" | "error" }
	| { type: "approval_requested"; toolCallId: string; toolName: string }
	| { type: "approval_resolved"; toolCallId: string; outcome: "approved" | "denied" }
	| { type: "agent_settled"; outcome: OPetOutcome; durationMs: number };

export interface OPetHelloMessage {
	type: "hello";
	clientId: string;
	sessionId: string;
}

export interface OPetEventMessage {
	type: "event";
	event: OPetEvent;
}

export interface OPetGoodbyeMessage {
	type: "goodbye";
}

export type OPetClientMessage = OPetHelloMessage | OPetEventMessage | OPetGoodbyeMessage;

export function serializeOPetMessage(message: OPetClientMessage): string {
	return `${JSON.stringify(message)}\n`;
}
