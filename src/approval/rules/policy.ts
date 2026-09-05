import picomatch from "picomatch";

import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalRule, ApprovalUnit, BashApprovalRequest } from "../types.js";
import type { ApprovalRuleMatcher } from "./allow.js";
import { collectBashFacts, type BashFactEvaluation } from "./bash-facts.js";

export function evaluateGatePolicy(request: ApprovalRequest, config: ApprovalGateConfig, store: ApprovalRuleMatcher): ApprovalDecision {
	const bash = request.tool === "bash" ? collectBashFacts(request, config.tools.bash) : undefined;
	return decide(request, config, store, bash);
}

export function evaluateBashGatePolicy(
	request: BashApprovalRequest,
	config: ApprovalGateConfig,
	store: ApprovalRuleMatcher,
): { decision: ApprovalDecision; bash: BashFactEvaluation } {
	const bash = collectBashFacts(request, config.tools.bash);
	return { decision: decide(request, config, store, bash), bash };
}

function decide(
	request: ApprovalRequest,
	config: ApprovalGateConfig,
	store: ApprovalRuleMatcher,
	bash: BashFactEvaluation | undefined,
): ApprovalDecision {
	// 显式拒绝和 Bash 拒绝事实不能被临时范围或放行记忆覆盖。
	const deniedRule = config.deny_rules.find((rule) => request.units.some((unit) => ruleMatchesUnit(rule, request.tool, unit)));
	if (deniedRule !== undefined) return { kind: "deny", reason: deniedRule.reason, rule_name: deniedRule.name };
	const deniedCombination = bash?.combinations.find(({ config }) => config.action === "deny");
	if (deniedCombination !== undefined) {
		return { kind: "deny", reason: `bash safety fact combination: ${deniedCombination.name}`, rule_name: deniedCombination.name };
	}
	const deniedFact = bash?.matches.find((match) => match.action === "deny");
	if (deniedFact !== undefined) return { kind: "deny", reason: `bash safety fact: ${deniedFact.fact}`, rule_name: deniedFact.fact };
	if (request.tool === "bash" && config.tools.bash.default_action === "deny") {
		return { kind: "deny", reason: "default bash fact policy", rule_name: "default-bash-policy" };
	}

	const asked = new Map<string, { unit: ApprovalUnit; reasons: Set<string> }>();
	const exempt = new Map<ApprovalUnit, boolean>();
	function isExempt(unit: ApprovalUnit): boolean {
		let allowed = exempt.get(unit);
		if (allowed === undefined) {
			allowed = unit.effect_scope === "temporary" || store.matchesAllowRule(request, unit);
			exempt.set(unit, allowed);
		}
		return allowed;
	}
	function ask(unit: ApprovalUnit, reason: string): void {
		if (isExempt(unit)) return;
		const key = `${unit.action}\0${unit.target.kind}\0${unit.target.value}`;
		const existing = asked.get(key);
		if (existing === undefined) asked.set(key, { unit, reasons: new Set([reason]) });
		else existing.reasons.add(reason);
	}

	for (const unit of request.units) {
		if (isExempt(unit)) continue;
		const rule = config.ask_rules.find((rule) => ruleMatchesUnit(rule, request.tool, unit));
		if (rule !== undefined) ask(unit, rule.reason);
		else if (request.tool !== "bash") {
			// 非 Bash 默认动作只处理尚未被路径规则、临时范围和记忆规则覆盖的单元。
			const action = config.tools[request.tool].default_action;
			const reason = `default ${request.tool} approval policy`;
			if (action === "deny") return { kind: "deny", reason };
			if (action === "ask") ask(unit, reason);
		}
	}
	if (bash !== undefined) {
		for (const match of bash.matches) {
			if (match.action === "ask") ask(match.unit, `bash safety fact: ${match.fact}`);
		}
		for (const { name, config } of bash.combinations) {
			if (config.action !== "ask") continue;
			for (const match of bash.matches) {
				if (config.all.includes(match.fact)) ask(match.unit, `bash safety fact combination: ${name}`);
			}
		}
		if (config.tools.bash.default_action === "ask") {
			for (const unit of request.units) ask(unit, "default bash fact policy");
		}
	}
	if (asked.size === 0) return { kind: "allow" };
	return {
		kind: "ask",
		reason: [...new Set([...asked.values()].flatMap(({ reasons }) => [...reasons]))].join("; "),
		items: [...asked.values()].map(({ unit, reasons }) => ({ unit, reason: [...reasons].join("; ") })),
	};
}

function ruleMatchesUnit(rule: ApprovalRule, tool: string, unit: ApprovalUnit): boolean {
	if (!rule.tools.includes(tool)) return false;
	if (rule.path_globs === undefined) return true;
	return unit.target.kind === "path" && rule.path_globs.some((glob) =>
		picomatch(glob.replace(/\\/g, "/"), { dot: true, nonegate: true })(unit.target.value.replace(/\\/g, "/")));
}
