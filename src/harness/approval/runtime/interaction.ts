import type { Askpass } from "../../bash-runtime/askpass.ts";
import type { SessionApprovalStore } from "../rules/store.ts";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.ts";

export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow for session";
const DENY = "Deny";
export const DENY_WITH_INSTRUCTION = "Deny with instruction";
const USER_DENIED_REASON = "User denied this tool call.";

const APPROVAL_OPTIONS = [ALLOW_ONCE, ALLOW_SESSION, DENY, DENY_WITH_INSTRUCTION] as const;
export type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number];
export type ApprovalOptions = readonly [ApprovalChoice, ...ApprovalChoice[]];

export interface ApprovalDialogOptions {
	timeout?: number;
}

type Approved = { kind: "approved"; askpass?: Askpass };
export type ApprovalOutcome = Approved | { kind: "blocked"; reason: string };
export type ApprovalAnswer = Approved | { kind: "remember" } | { kind: "denied"; instruction?: string | undefined };

export type ApprovalInteraction = (
	request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>,
	options: ApprovalOptions, dialogOptions?: ApprovalDialogOptions,
) => Promise<ApprovalAnswer>;

export function answerForChoice(choice: string | undefined): ApprovalAnswer {
	if (choice === ALLOW_ONCE) return { kind: "approved" };
	if (choice === ALLOW_SESSION) return { kind: "remember" };
	return { kind: "denied" };
}

export async function handleAskDecision(
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	config: ApprovalGateConfig,
	store: SessionApprovalStore,
	interaction: ApprovalInteraction,
): Promise<ApprovalOutcome> {
	const remember = store.prepareGrant(request, decision.items.map(({ unit }) => unit));
	const options: ApprovalOptions = remember ? APPROVAL_OPTIONS : [ALLOW_ONCE, DENY, DENY_WITH_INSTRUCTION];
	const answer = await interaction(request, decision, options, dialogOptions(config));
	switch (answer.kind) {
		case "approved": return answer;
		case "denied": return { kind: "blocked", reason: formatDenyReason(answer.instruction) };
		case "remember":
			if (!remember) return { kind: "blocked", reason: USER_DENIED_REASON };
			remember();
			return { kind: "approved" };
	}
}

function dialogOptions(config: ApprovalGateConfig): ApprovalDialogOptions | undefined {
	return config.ui.timeout_ms > 0 ? { timeout: config.ui.timeout_ms } : undefined;
}

function formatDenyReason(instruction: string | undefined): string {
	const trimmed = instruction?.trim();
	if (trimmed === undefined || trimmed.length === 0) return USER_DENIED_REASON;
	return `${USER_DENIED_REASON}\n\nInstruction from user:\n${trimmed}`;
}
