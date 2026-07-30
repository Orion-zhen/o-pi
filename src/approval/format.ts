import type { ApprovalDecision, ApprovalRequest } from "./types.js";

export const USER_DENIED_REASON = "User denied this tool call.";

export function formatApprovalPrompt(request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>): string {
	return [
		"Approval required",
		"",
		"Tool:",
		request.tool,
		"",
		"Requested:",
		request.summary,
		"",
		"Sensitive units:",
		...decision.items.flatMap((item, index) => [
			`${index + 1}. ${item.unit.target.value}`,
			`   Action: ${item.unit.action}`,
			`   Reason: ${item.reason}`,
			`   Effects: ${item.unit.effects.join(", ")}`,
		]),
	].join("\n");
}

export function formatDenyReason(instruction: string | undefined): string {
	const trimmed = instruction?.trim();
	if (trimmed === undefined || trimmed.length === 0) return USER_DENIED_REASON;
	return `${USER_DENIED_REASON}\n\nInstruction from user:\n${trimmed}`;
}
