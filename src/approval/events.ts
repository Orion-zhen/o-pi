export const APPROVAL_STATUS_CHANNEL = "approval-gate:status";

export type ApprovalStatusEvent =
	| { type: "requested"; toolCallId: string; toolName: string }
	| { type: "resolved"; toolCallId: string; outcome: "approved" | "denied" };
