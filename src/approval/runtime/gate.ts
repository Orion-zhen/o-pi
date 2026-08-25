import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { notifyWaiting, type WaitingNotifier } from "../../notification/native.js";
import { loadApprovalGateConfig } from "../config.js";
import { buildApprovalRequest } from "../request/build.js";
import { evaluateGatePolicy } from "../rules/policy.js";
import { FileApprovalStore, type ApprovalStore } from "../rules/store.js";
import type { ApprovalDecision, ApprovalGateConfig } from "../types.js";
import { handleAskDecision, type ApprovalInteractionPort } from "./interaction.js";

export interface ApprovalGate {
	handleToolCall(event: ToolCallEvent, context: ApprovalContext): Promise<ToolCallEventResult | void>;
}

export interface ApprovalContext {
	cwd: string;
	interaction?: ApprovalInteractionPort;
}

export interface ApprovalGateOptions {
	loadConfig?: () => Promise<ApprovalGateConfig>;
	store?: ApprovalStore;
	notifyUser?: WaitingNotifier;
}

interface ApprovalStoreInitialization {
	readonly path: string;
	readonly ready: Promise<ApprovalStore>;
}

export function createApprovalGate(options: ApprovalGateOptions = {}): ApprovalGate {
	let storeInitialization: ApprovalStoreInitialization | undefined;

	const resolveStore = async (storePath: string): Promise<ApprovalStore> => {
		if (options.store !== undefined) return options.store;
		const existing = storeInitialization;
		const initialization = existing?.path === storePath ? existing : initializeStore(storePath);
		storeInitialization = initialization;
		try {
			return await initialization.ready;
		} catch (error) {
			if (storeInitialization === initialization) storeInitialization = undefined;
			throw error;
		}
	};

	function initializeStore(storePath: string): ApprovalStoreInitialization {
		const store = new FileApprovalStore(storePath);
		return { path: storePath, ready: store.loadPersistentRules().then(() => store) };
	}

	return {
		async handleToolCall(event, ctx) {
			const config = await (options.loadConfig ?? loadApprovalGateConfig)();
			if (!config.enabled) return undefined;

			const request = await buildApprovalRequest(event, ctx.cwd);
			if (request === undefined) return undefined;

			const store = await resolveStore(config.remember.persistent_store);
			const decision = evaluateGatePolicy(request, config, store);
			if (decision.kind === "allow") return undefined;
			if (decision.kind === "deny") return blockForDenyRule(decision);

			if (ctx.interaction === undefined) {
				if (config.ui.non_interactive === "allow") return undefined;
				return { block: true, reason: `Approval required but no interactive UI is available: ${decision.reason}` };
			}

			return handleAskDecision(
				request,
				decision,
				config,
				store,
				ctx.interaction,
				options.notifyUser ?? notifyWaiting,
			);
		},
	};
}

function blockForDenyRule(decision: Extract<ApprovalDecision, { kind: "deny" }>): ToolCallEventResult {
	const source = decision.rule_name === undefined ? "Approval Gate" : `Approval Gate rule "${decision.rule_name}"`;
	return { block: true, reason: `Blocked by ${source}: ${decision.reason}` };
}
