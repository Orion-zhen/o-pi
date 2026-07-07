import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { loadBashToolConfig } from "../bash-tool/config.js";
import { loadFileToolsConfig } from "../file-tools/config.js";
import { isFailed } from "../file-tools/errors.js";
import { PathGuardBlockedError, guardWritablePath } from "../safety/path-guard.js";
import { checkDeniedText } from "../safety/pattern-guard.js";
import { loadApprovalGateConfig } from "./config.js";
import { formatApprovalPrompt, formatDenyReason } from "./format.js";
import { evaluateApproval } from "./policy.js";
import { buildApprovalRequest } from "./request-builder.js";
import { FileApprovalStore, createExactAllowRule, createSimilarAllowRule, describeAllowRule, type ApprovalStore } from "./store.js";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "./types.js";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALLOW_PERSISTENT = "Always allow similar";
const DENY = "Deny";
const DENY_WITH_INSTRUCTION = "Deny with instruction";

export interface ApprovalGate {
	handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void>;
}

interface ApprovalGateOptions {
	loadConfig?: () => Promise<ApprovalGateConfig>;
	store?: ApprovalStore;
}

export function createApprovalGate(options: ApprovalGateOptions = {}): ApprovalGate {
	let store: ApprovalStore | undefined = options.store;
	let loadedStorePath: string | undefined;

	return {
		async handleToolCall(event, ctx) {
			const config = await (options.loadConfig ?? loadApprovalGateConfig)();
			if (!config.enabled) return undefined;

			const request = buildApprovalRequest(event, ctx.cwd);
			if (request === undefined) return undefined;

			const safetyBlock = await precheckSafety(event, ctx.cwd);
			if (safetyBlock !== undefined) return safetyBlock;

			if (store === undefined || (options.store === undefined && loadedStorePath !== config.remember.persistent_store)) {
				store = new FileApprovalStore(config.remember.persistent_store);
				loadedStorePath = config.remember.persistent_store;
				await store.loadPersistentRules();
			}

			const decision = evaluateApproval(request, config, store);
			if (decision.kind === "allow") return undefined;
			if (decision.kind === "deny") return blockForDenyRule(decision);

			if (!ctx.hasUI) {
				if (config.ui.non_interactive === "allow") return undefined;
				return { block: true, reason: `Approval required but no interactive UI is available: ${decision.reason}` };
			}

			return handleAskDecision(request, decision, config, store, ctx);
		},
	};
}

export async function handleApprovalToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
	return createApprovalGate().handleToolCall(event, ctx);
}

async function handleAskDecision(
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	config: ApprovalGateConfig,
	store: ApprovalStore,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | void> {
	const options = approvalOptions(config);
	const choice = await ctx.ui.select(formatApprovalPrompt(request, decision), options, dialogOptions(config));
	if (choice === ALLOW_ONCE) return undefined;
	if (choice === ALLOW_SESSION) {
		const rule = createExactAllowRule(request);
		if (rule !== undefined) store.addSessionAllowRule(rule);
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
		return undefined;
	}
	if (choice === DENY_WITH_INSTRUCTION) {
		const instruction = await ctx.ui.input(
			"Instruction for agent",
			"Explain why this tool call was denied or what the agent should do instead.",
			dialogOptions(config),
		);
		return { block: true, reason: formatDenyReason(instruction) };
	}
	return { block: true, reason: formatDenyReason(undefined) };
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
	if (isFailed(config)) return undefined;
	try {
		await guardWritablePath(filePath, { cwd, blocked_path: config.blocked_path });
	} catch (error) {
		if (error instanceof PathGuardBlockedError) {
			return {
				block: true,
				reason: `Blocked by safety policy: ${error.block.message} Matched path rule: ${error.block.matched_rule ?? "unknown"}`,
			};
		}
	}
	return undefined;
}

async function loadBashConfigForPrecheck(): Promise<Awaited<ReturnType<typeof loadBashToolConfig>> | undefined> {
	try {
		return await loadBashToolConfig();
	} catch {
		return undefined;
	}
}
