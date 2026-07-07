import type { ApprovalDecision, ApprovalRequest } from "./types.js";

export const USER_DENIED_REASON = "User denied this tool call.";

export function formatApprovalPrompt(request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>): string {
	return [
		"Approval required",
		"",
		"Tool:",
		request.tool,
		"",
		"Action:",
		request.action,
		"",
		"Target:",
		formatTargets(request),
		"",
		"Reason:",
		decision.reason,
		"",
		"Effects:",
		request.effects.join(", "),
	].join("\n");
}

export function formatDenyReason(instruction: string | undefined): string {
	const trimmed = instruction?.trim();
	if (trimmed === undefined || trimmed.length === 0) return USER_DENIED_REASON;
	return `${USER_DENIED_REASON}\n\nInstruction from user:\n${trimmed}`;
}

export function formatTargets(request: ApprovalRequest): string {
	return request.targets.map((target) => target.value).join("\n");
}
