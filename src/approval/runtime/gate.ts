import { evaluateGatePolicy } from "../rules/policy.js";
import { FileApprovalStore, type ApprovalStore } from "../rules/store.js";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.js";
import { handleAskDecision, type ApprovalOutcome, type ApprovalInteractionPort } from "./interaction.js";

interface ApprovalGate {
	authorize(request: ApprovalRequest, config: ApprovalGateConfig, interaction?: ApprovalInteractionPort): Promise<ApprovalOutcome>;
}

export function createApprovalGate(): ApprovalGate {
	let initialization: { path: string; ready: Promise<ApprovalStore> } | undefined;

	async function resolveStore(path: string): Promise<ApprovalStore> {
		if (initialization?.path !== path) initialization = { path, ready: FileApprovalStore.open(path) };
		const pending = initialization;
		try {
			return await pending.ready;
		} catch (error) {
			if (initialization === pending) initialization = undefined;
			throw error;
		}
	}

	return {
		async authorize(request, config, interaction) {
			const store = await resolveStore(config.remember.persistent_store);
			const decision = evaluateGatePolicy(request, config, store);
			if (decision.kind === "allow") return { kind: "approved" };
			if (decision.kind === "deny") return blockForDenyRule(decision);
			if (interaction === undefined) {
				return config.ui.non_interactive === "allow"
					? { kind: "approved" }
					: { kind: "blocked", reason: `Approval required but no interactive UI is available: ${decision.reason}` };
			}
			return handleAskDecision(request, decision, config, store, interaction);
		},
	};
}

function blockForDenyRule(decision: Extract<ApprovalDecision, { kind: "deny" }>): ApprovalOutcome {
	const source = decision.rule_name === undefined ? "Approval Gate" : `Approval Gate rule "${decision.rule_name}"`;
	return { kind: "blocked", reason: `Blocked by ${source}: ${decision.reason}` };
}
