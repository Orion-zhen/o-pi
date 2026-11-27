import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalUnit, ShellApprovalRequest, ShellPolicyConfig, FileFact, NetworkFact, SingleTargetRequest, ToolPolicy } from "../types.ts";
import type { ApprovalRuleMatcher } from "./store.ts";
import { collectShellFacts, type ShellFactEvaluation } from "./shell-facts.ts";
import { matchesTargetPath } from "./path-match.ts";

const defaultAskReason = "This tool requires approval by default.";

export function evaluateGatePolicy(request: ApprovalRequest, config: ApprovalGateConfig, store: ApprovalRuleMatcher): ApprovalDecision {
	if ("units" in request) return evaluateShellGatePolicy(request, config.tools.shell, store).decision;
	if (request.tool === "webfetch") {
		return decideTarget(request, config.tools.webfetch, store, (fact) => "match_all" in fact || fact.network_scope === request.detail.scope);
	}
	return decideTarget(request, config.tools[request.tool], store,
		(fact) => "match_all" in fact || matchesTargetPath(request.unit.target, fact.path_globs));
}

function decideTarget<F extends FileFact | NetworkFact>(
	request: SingleTargetRequest, policy: ToolPolicy<F>, store: ApprovalRuleMatcher, matches: (fact: F) => boolean,
): ApprovalDecision {
	const { unit } = request;
	const reasons = new Set<string>();
	for (const [id, fact] of Object.entries(policy.facts)) {
		if (!matches(fact)) continue;
		if (fact.action === "deny") return { kind: "deny", reason: fact.reason, rule_name: id };
		reasons.add(fact.reason);
	}
	if (isExempt(request, unit, store)) return { kind: "allow" };
	if (reasons.size === 0) {
		if (policy.default_action === "allow") return { kind: "allow" };
		if (policy.default_action === "deny") return { kind: "deny", reason: `default ${request.tool} approval policy` };
		reasons.add(defaultAskReason);
	}
	const reason = [...reasons].join("; ");
	return { kind: "ask", reason, items: [{ unit, reason }] };
}

export function evaluateShellGatePolicy(
	request: ShellApprovalRequest, policy: ShellPolicyConfig, store: ApprovalRuleMatcher,
): { decision: ApprovalDecision; facts: ShellFactEvaluation } {
	const facts = collectShellFacts(request, policy);
	return { decision: decideShell(request, policy.default_action, store, facts), facts };
}

function decideShell(
	request: ShellApprovalRequest, defaultAction: ApprovalDecision["kind"], store: ApprovalRuleMatcher, { matches, combinations, unresolved }: ShellFactEvaluation,
): ApprovalDecision {
	for (const { name, config } of combinations) {
		if (config.action === "deny") return { kind: "deny", reason: config.reason, rule_name: name };
	}
	for (const { fact, config } of matches) {
		if (config.action === "deny") return { kind: "deny", reason: config.reason, rule_name: fact };
	}
	if (defaultAction === "deny") return { kind: "deny", reason: `default ${request.tool} fact policy`, rule_name: `default-${request.tool}-policy` };

	const asked = new Map<string, { unit: ApprovalUnit; reasons: Set<string> }>();
	function ask(unit: ApprovalUnit, reason?: string): void {
		if (isExempt(request, unit, store)) return;
		const key = `${unit.action}\0${unit.target.kind}\0${unit.target.value}`;
		const existing = asked.get(key);
		if (existing === undefined) asked.set(key, { unit, reasons: new Set([reason ?? defaultAskReason]) });
		else {
			if (reason !== undefined) existing.reasons.add(reason);
			if (!existing.unit.analysisNote && unit.analysisNote) existing.unit = { ...existing.unit, analysisNote: unit.analysisNote };
		}
	}
	for (const { config, unit } of matches) {
		if (config.action === "ask") ask(unit, config.reason);
	}
	for (const { config } of combinations) {
		for (const match of matches) {
			if (config.all.includes(match.fact)) ask(match.unit, config.reason);
		}
	}
	for (const { unit, rule, reason } of unresolved) ask(unit, `Possible match (${rule}): ${reason}`);
	if (defaultAction === "ask") {
		for (const unit of request.units) ask(unit);
	}
	if (asked.size === 0) return { kind: "allow" };
	return {
		kind: "ask",
		reason: [...new Set([...asked.values()].flatMap(({ reasons }) => [...reasons]))].join("; "),
		items: [...asked.values()].map(({ unit, reasons }) => ({ unit, reason: [...reasons].join("; ") })),
	};
}

function isExempt(request: ApprovalRequest, unit: ApprovalUnit, store: ApprovalRuleMatcher): boolean {
	return unit.effect_scope !== undefined || store.matchesAllowRule(request, unit);
}
