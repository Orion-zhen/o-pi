import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { WaitingNotifier } from "../../notification/native.js";
import { createExactAllowRules, createSimilarAllowRules, describeAllowRules } from "../rules/allow.js";
import type { ApprovalStore } from "../rules/store.js";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.js";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALLOW_PERSISTENT = "Always allow similar";
const DENY = "Deny";
const DENY_WITH_INSTRUCTION = "Deny with instruction";
const USER_DENIED_REASON = "User denied this tool call.";

export interface ApprovalInteractionPort {
	select(title: string, options: string[], optionsOverride?: { timeout?: number }): Promise<string | undefined>;
	input(title: string, placeholder: string, optionsOverride?: { timeout?: number }): Promise<string | undefined>;
	notify(message: string, type: "info" | "warning"): void;
}

export async function handleAskDecision(
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	config: ApprovalGateConfig,
	store: ApprovalStore,
	interaction: ApprovalInteractionPort,
	notifyUser: WaitingNotifier,
): Promise<ToolCallEventResult | void> {
	const askedUnits = decision.items.map((item) => item.unit);
	const options = approvalOptions(
		config,
		askedUnits.every((unit) => unit.remember.session),
		askedUnits.every((unit) => unit.remember.persistent),
	);
	await notifyUserSafely(notifyUser);
	const choice = await interaction.select(formatApprovalPrompt(request, decision), options, dialogOptions(config));
	const acceptedChoice = choice !== undefined && options.includes(choice) ? choice : undefined;
	if (acceptedChoice === ALLOW_ONCE) return undefined;
	if (acceptedChoice === ALLOW_SESSION) {
		store.addSessionAllowRules(createExactAllowRules(request, askedUnits));
		return undefined;
	}
	if (acceptedChoice === ALLOW_PERSISTENT) {
		const rules = createSimilarAllowRules(request, askedUnits);
		try {
			await store.addPersistentAllowRules(rules);
			interaction.notify(`Approval rules saved: ${describeAllowRules(rules)}`, "info");
		} catch (error) {
			interaction.notify(`Approval rules were not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		return undefined;
	}
	if (acceptedChoice === DENY_WITH_INSTRUCTION) {
		const instruction = await interaction.input(
			"Instruction for agent",
			"Explain why this tool call was denied or what the agent should do instead.",
			dialogOptions(config),
		);
		return { block: true, reason: formatDenyReason(instruction) };
	}
	return { block: true, reason: formatDenyReason(undefined) };
}

async function notifyUserSafely(notifyUser: WaitingNotifier): Promise<void> {
	try {
		await notifyUser();
	} catch {
		// 通知后端不可用时不得阻塞权限审批。
	}
}

function approvalOptions(config: ApprovalGateConfig, canRememberSession: boolean, canRememberPersistent: boolean): string[] {
	const options = [ALLOW_ONCE];
	if (config.remember.allow_session && canRememberSession) options.push(ALLOW_SESSION);
	if (config.remember.allow_persistent && canRememberPersistent) options.push(ALLOW_PERSISTENT);
	options.push(DENY, DENY_WITH_INSTRUCTION);
	return options;
}

function dialogOptions(config: ApprovalGateConfig): { timeout?: number } | undefined {
	return config.ui.timeout_ms > 0 ? { timeout: config.ui.timeout_ms } : undefined;
}

function formatApprovalPrompt(request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>): string {
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
		]),
	].join("\n");
}

function formatDenyReason(instruction: string | undefined): string {
	const trimmed = instruction?.trim();
	if (trimmed === undefined || trimmed.length === 0) return USER_DENIED_REASON;
	return `${USER_DENIED_REASON}\n\nInstruction from user:\n${trimmed}`;
}
