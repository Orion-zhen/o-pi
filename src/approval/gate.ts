import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { loadBashToolConfig } from "../bash-tool/config.js";
import { loadFileToolsConfig } from "../file-tools-config/config.js";
import { preflightWriteAccess } from "../filesystem/kernel/access-preflight.js";
import { checkDeniedText } from "../safety/pattern-guard.js";
import { loadApprovalGateConfig } from "./config.js";
import { formatApprovalPrompt, formatDenyReason } from "./format.js";
import { evaluateApproval } from "./policy.js";
import { buildApprovalRequest } from "./request-builder.js";
import { FileApprovalStore, createExactAllowRule, createSimilarAllowRule, describeAllowRule, type ApprovalStore } from "./store.js";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalTelemetryObserver } from "./types.js";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALLOW_PERSISTENT = "Always allow similar";
const DENY = "Deny";
const DENY_WITH_INSTRUCTION = "Deny with instruction";

export interface ApprovalGate {
	handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void>;
}

export interface ApprovalGateOptions {
	loadConfig?: () => Promise<ApprovalGateConfig>;
	store?: ApprovalStore;
	telemetry?: ApprovalTelemetryObserver;
}

export function createApprovalGate(options: ApprovalGateOptions = {}): ApprovalGate {
	let store: ApprovalStore | undefined = options.store;
	let loadedStorePath: string | undefined;

	return {
		async handleToolCall(event, ctx) {
			const observe = (approval: Parameters<ApprovalTelemetryObserver>[2]) => recordApproval(
				options.telemetry,
				event.toolCallId,
				event.toolName,
				approval,
			);
			const config = await (options.loadConfig ?? loadApprovalGateConfig)();
			if (!config.enabled) {
				observe({ decision: "allow", outcome: "gate_disabled", wait_ms: 0 });
				return undefined;
			}

			const request = buildApprovalRequest(event, ctx.cwd);
			if (request === undefined) {
				observe({ decision: "allow", outcome: "not_required", wait_ms: 0 });
				return undefined;
			}

			const safetyBlock = await precheckSafety(event, ctx.cwd);
			if (safetyBlock !== undefined) {
				observe({ decision: "deny", outcome: "safety_block", wait_ms: 0 });
				return safetyBlock;
			}

			if (store === undefined || (options.store === undefined && loadedStorePath !== config.remember.persistent_store)) {
				store = new FileApprovalStore(config.remember.persistent_store);
				loadedStorePath = config.remember.persistent_store;
				await store.loadPersistentRules();
			}

			const decision = evaluateApproval(request, config, store);
			if (decision.kind === "allow") {
				observe({ decision: "allow", outcome: "policy_allow", wait_ms: 0 });
				return undefined;
			}
			if (decision.kind === "deny") {
				observe({
					decision: "deny",
					outcome: "policy_deny",
					wait_ms: 0,
					...(decision.rule_name !== undefined ? { rule_name: decision.rule_name } : {}),
				});
				return blockForDenyRule(decision);
			}

			if (!ctx.hasUI) {
				if (config.ui.non_interactive === "allow") {
					observe({ decision: "allow", outcome: "non_interactive_allow", wait_ms: 0 });
					return undefined;
				}
				observe({ decision: "deny", outcome: "non_interactive_block", wait_ms: 0 });
				return { block: true, reason: `Approval required but no interactive UI is available: ${decision.reason}` };
			}

			return handleAskDecision(event.toolCallId, event.toolName, request, decision, config, store, ctx, options.telemetry);
		},
	};
}

export async function handleApprovalToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
	return createApprovalGate().handleToolCall(event, ctx);
}

async function handleAskDecision(
	toolCallId: string,
	toolName: string,
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	config: ApprovalGateConfig,
	store: ApprovalStore,
	ctx: ExtensionContext,
	telemetry: ApprovalTelemetryObserver | undefined,
): Promise<ToolCallEventResult | void> {
	const options = approvalOptions(config);
	const startedAt = Date.now();
	const choice = await ctx.ui.select(formatApprovalPrompt(request, decision), options, dialogOptions(config));
	const selectionWaitMs = Math.max(0, Date.now() - startedAt);
	if (choice === ALLOW_ONCE) {
		recordAsk(telemetry, toolCallId, toolName, "allow_once", selectionWaitMs, decision.rule_name);
		return undefined;
	}
	if (choice === ALLOW_SESSION) {
		const rule = createExactAllowRule(request);
		if (rule !== undefined) store.addSessionAllowRule(rule);
		recordAsk(telemetry, toolCallId, toolName, "allow_session", selectionWaitMs, decision.rule_name);
		return undefined;
	}
	if (choice === ALLOW_PERSISTENT) {
		const rule = createSimilarAllowRule(request);
		if (rule !== undefined) {
			try {
				await store.addPersistentAllowRule(rule);
				ctx.ui.notify(`Approval rule saved: ${describeAllowRule(rule)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Approval rule was not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		recordAsk(telemetry, toolCallId, toolName, "allow_persistent", selectionWaitMs, decision.rule_name);
		return undefined;
	}
	if (choice === DENY_WITH_INSTRUCTION) {
		const instruction = await ctx.ui.input(
			"Instruction for agent",
			"Explain why this tool call was denied or what the agent should do instead.",
			dialogOptions(config),
		);
		recordAsk(telemetry, toolCallId, toolName, "deny_with_instruction", Math.max(0, Date.now() - startedAt), decision.rule_name);
		return { block: true, reason: formatDenyReason(instruction) };
	}
	recordAsk(telemetry, toolCallId, toolName, choice === DENY ? "deny" : "dismissed", selectionWaitMs, decision.rule_name);
	return { block: true, reason: formatDenyReason(undefined) };
}

function recordAsk(
	telemetry: ApprovalTelemetryObserver | undefined,
	toolCallId: string,
	toolName: string,
	outcome: "allow_once" | "allow_session" | "allow_persistent" | "deny" | "deny_with_instruction" | "dismissed",
	waitMs: number,
	ruleName: string | undefined,
): void {
	recordApproval(telemetry, toolCallId, toolName, {
		decision: "ask",
		outcome,
		wait_ms: waitMs,
		...(ruleName !== undefined ? { rule_name: ruleName } : {}),
	});
}

function recordApproval(
	telemetry: ApprovalTelemetryObserver | undefined,
	toolCallId: string,
	toolName: string,
	approval: Parameters<ApprovalTelemetryObserver>[2],
): void {
	try {
		telemetry?.(toolCallId, toolName, approval);
	} catch {
		// Approval behavior must not depend on diagnostic observers.
	}
}

function approvalOptions(config: ApprovalGateConfig): string[] {
	const options = [ALLOW_ONCE];
	if (config.remember.allow_session) options.push(ALLOW_SESSION);
	if (config.remember.allow_persistent) options.push(ALLOW_PERSISTENT);
	options.push(DENY, DENY_WITH_INSTRUCTION);
	return options;
}

function dialogOptions(config: ApprovalGateConfig): { timeout?: number } | undefined {
	return config.ui.timeout_ms > 0 ? { timeout: config.ui.timeout_ms } : undefined;
}

function blockForDenyRule(decision: Extract<ApprovalDecision, { kind: "deny" }>): ToolCallEventResult {
	const rule = decision.rule_name === undefined ? "unnamed" : decision.rule_name;
	return { block: true, reason: `Blocked by approval deny rule "${rule}": ${decision.reason}` };
}

async function precheckSafety(event: ToolCallEvent, cwd: string): Promise<ToolCallEventResult | undefined> {
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : undefined;
		if (command === undefined) return undefined;
		const config = await loadBashConfigForPrecheck();
		if (config === undefined) return undefined;
		const match = checkDeniedText(command, config.safety);
		if (match !== null) return { block: true, reason: `Blocked by safety policy: ${match.message} Matched ${match.kind}: ${match.rule}` };
		return undefined;
	}
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const filePath = typeof event.input.path === "string" ? event.input.path : undefined;
	if (filePath === undefined) return undefined;
	const config = await loadFileToolsConfig(cwd);
	if (!config.ok) return undefined;
	const preflight = await preflightWriteAccess({ cwd, path: filePath, blockedPaths: config.value.filesystem.blockedPaths });
	if (preflight.ok || preflight.error.code !== "blocked") return undefined;
	const matchedRule = typeof preflight.error.details?.["matchedRule"] === "string"
		? preflight.error.details["matchedRule"]
		: "unknown";
	return {
		block: true,
		reason: `Blocked by safety policy: Path is blocked by file-tools config. Matched path rule: ${matchedRule}`,
	};
}

async function loadBashConfigForPrecheck(): Promise<Awaited<ReturnType<typeof loadBashToolConfig>> | undefined> {
	try {
		return await loadBashToolConfig();
	} catch {
		return undefined;
	}
}
