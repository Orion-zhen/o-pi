import { evaluateGatePolicy } from "../rules/policy.ts";
import { ApprovalStores, SessionApprovalRules } from "../rules/store.ts";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.ts";
import { handleAskDecision, type ApprovalOutcome, type ApprovalInteractionPort } from "./interaction.ts";

interface ApprovalGate {
	authorize(request: ApprovalRequest, config: ApprovalGateConfig, interaction?: ApprovalInteractionPort): Promise<ApprovalOutcome>;
}

export function createApprovalGate(stores = new ApprovalStores(), sessionRules = new SessionApprovalRules()): ApprovalGate {
	return {
		async authorize(request, config, interaction) {
			const file = await stores.open(config.remember.persistent_store);
			await file.refresh();
			const store = file.forSession(sessionRules);
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
