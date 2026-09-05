import { notifyWaiting } from "../../notification/native.js";
import { createExactAllowRules, createSimilarAllowRules, describeAllowRules } from "../rules/allow.js";
import type { ApprovalStore } from "../rules/store.js";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.js";

export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow for session";
export const ALLOW_PERSISTENT = "Always allow similar";
const DENY = "Deny";
export const DENY_WITH_INSTRUCTION = "Deny with instruction";
const USER_DENIED_REASON = "User denied this tool call.";

export type ApprovalChoice =
	| typeof ALLOW_ONCE
	| typeof ALLOW_SESSION
	| typeof ALLOW_PERSISTENT
	| typeof DENY
	| typeof DENY_WITH_INSTRUCTION;
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
	notify(message: string, type: "info" | "warning"): void;
}

export async function handleAskDecision(
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	config: ApprovalGateConfig,
	store: ApprovalStore,
	interaction: ApprovalInteractionPort,
): Promise<ApprovalOutcome> {
	const askedUnits = decision.items.map((item) => item.unit);
	const options = approvalOptions(
		config,
		askedUnits.every((unit) => unit.remember.session),
		askedUnits.every((unit) => unit.remember.persistent),
	);
	await notifyWaiting();
	const choice = await interaction.approve(request, decision, options, dialogOptions(config));
	const acceptedChoice = choice !== undefined && isOfferedChoice(choice, options) ? choice : undefined;
	if (acceptedChoice === ALLOW_ONCE) return { kind: "approved" };
	if (acceptedChoice === ALLOW_SESSION) {
		store.addSessionAllowRules(createExactAllowRules(request, askedUnits));
		return { kind: "approved" };
	}
	if (acceptedChoice === ALLOW_PERSISTENT) {
		const rules = createSimilarAllowRules(request, askedUnits);
		try {
			await store.addPersistentAllowRules(rules);
			interaction.notify(`Approval rules saved: ${describeAllowRules(rules)}`, "info");
		} catch (error) {
			interaction.notify(`Approval rules were not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		return { kind: "approved" };
	}
	if (acceptedChoice === DENY_WITH_INSTRUCTION) {
		const instruction = await interaction.input(
			"Instruction for agent",
			"Explain why this tool call was denied or what the agent should do instead.",
			dialogOptions(config),
		);
		return { kind: "blocked", reason: formatDenyReason(instruction) };
	}
	return { kind: "blocked", reason: formatDenyReason(undefined) };
}

function approvalOptions(
	config: ApprovalGateConfig,
	canRememberSession: boolean,
	canRememberPersistent: boolean,
): ApprovalOptions {
	const remembered: ApprovalChoice[] = [];
	if (config.remember.allow_session && canRememberSession) remembered.push(ALLOW_SESSION);
	if (config.remember.allow_persistent && canRememberPersistent) remembered.push(ALLOW_PERSISTENT);
	return [ALLOW_ONCE, ...remembered, DENY, DENY_WITH_INSTRUCTION];
}

function isOfferedChoice(choice: string, options: ApprovalOptions): choice is ApprovalChoice {
	return options.some((option) => option === choice);
}

function dialogOptions(config: ApprovalGateConfig): ApprovalDialogOptions | undefined {
	return config.ui.timeout_ms > 0 ? { timeout: config.ui.timeout_ms } : undefined;
}

function formatDenyReason(instruction: string | undefined): string {
	const trimmed = instruction?.trim();
	if (trimmed === undefined || trimmed.length === 0) return USER_DENIED_REASON;
	return `${USER_DENIED_REASON}\n\nInstruction from user:\n${trimmed}`;
}
