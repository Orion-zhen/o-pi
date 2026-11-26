import { evaluateGatePolicy } from "../rules/policy.ts";
import { SessionApprovalStore } from "../rules/store.ts";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.ts";
import { handleAskDecision, type ApprovalOutcome, type ApprovalInteraction } from "./interaction.ts";

interface ApprovalGate {
	authorize(request: ApprovalRequest, config: ApprovalGateConfig, interaction?: ApprovalInteraction): Promise<ApprovalOutcome>;
}

export function createApprovalGate(store = new SessionApprovalStore()): ApprovalGate {
	return {
		async authorize(request, config, interaction) {
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
