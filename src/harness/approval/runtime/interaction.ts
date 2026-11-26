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

export type ApprovalOutcome = { kind: "approved" } | { kind: "blocked"; reason: string };

export interface ApprovalInteractionPort {
	approve(
		request: ApprovalRequest,
		decision: Extract<ApprovalDecision, { kind: "ask" }>,
		options: ApprovalOptions,
		optionsOverride?: ApprovalDialogOptions,
	): Promise<string | undefined>;
	input(title: string, placeholder: string, optionsOverride?: ApprovalDialogOptions): Promise<string | undefined>;
}

export async function handleAskDecision(
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	config: ApprovalGateConfig,
	store: SessionApprovalStore,
	interaction: ApprovalInteractionPort,
): Promise<ApprovalOutcome> {
	const choice = await interaction.approve(request, decision, APPROVAL_OPTIONS, dialogOptions(config));
	if (choice === ALLOW_ONCE) return { kind: "approved" };
	if (choice === ALLOW_SESSION) {
		store.remember(request, decision.items.map(({ unit }) => unit));
		return { kind: "approved" };
	}
	if (choice === DENY_WITH_INSTRUCTION) {
		const instruction = await interaction.input(
			"Instruction for agent",
			"Explain why this tool call was denied or what the agent should do instead.",
			dialogOptions(config),
		);
		return { kind: "blocked", reason: formatDenyReason(instruction) };
	}
	return { kind: "blocked", reason: formatDenyReason(undefined) };
}

function dialogOptions(config: ApprovalGateConfig): ApprovalDialogOptions | undefined {
	return config.ui.timeout_ms > 0 ? { timeout: config.ui.timeout_ms } : undefined;
}

function formatDenyReason(instruction: string | undefined): string {
	const trimmed = instruction?.trim();
	if (trimmed === undefined || trimmed.length === 0) return USER_DENIED_REASON;
	return `${USER_DENIED_REASON}\n\nInstruction from user:\n${trimmed}`;
}
