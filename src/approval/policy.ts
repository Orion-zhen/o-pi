import picomatch from "picomatch";

import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalRule, ApprovalUnit } from "./types.js";
import type { ApprovalStore } from "./store.js";

export function evaluateApproval(request: ApprovalRequest, config: ApprovalGateConfig, store: ApprovalStore): ApprovalDecision {
	if (!config.enabled) return { kind: "allow" };

	// 显式 deny 永远优先于会话或持久 allow。
	const deny = config.deny_rules.find((rule) => request.units.some((unit) => ruleMatchesUnit(rule, request.tool, unit)));
	if (deny !== undefined) return { kind: "deny", reason: deny.reason, rule_name: deny.name };

	const items: Extract<ApprovalDecision, { kind: "ask" }>["items"] = [];
	for (const unit of request.units) {
		if (store.matchesAllowRule(request, unit)) continue;

		const ask = config.ask_rules.find((rule) => ruleMatchesUnit(rule, request.tool, unit));
		if (ask !== undefined) {
			items.push({ unit, reason: ask.reason, rule_name: ask.name });
			continue;
		}

		const defaultAction = config.defaults[request.tool];
		if (defaultAction === "deny") return { kind: "deny", reason: `default ${request.tool} approval policy` };
		if (defaultAction === "ask") items.push({ unit, reason: `default ${request.tool} approval policy` });
	}

	if (items.length === 0) return { kind: "allow" };
	const reasons = [...new Set(items.map((item) => item.reason))];
	const firstRuleName = items[0]?.rule_name;
	return {
		kind: "ask",
		reason: reasons.join("; "),
		items,
		...(firstRuleName === undefined ? {} : { rule_name: firstRuleName }),
	};
}

export function ruleMatchesUnit(rule: ApprovalRule, tool: string, unit: ApprovalUnit): boolean {
	if (!rule.tools.includes(tool)) return false;

	const hasPathMatcher = rule.path_globs !== undefined && rule.path_globs.length > 0;
	const hasCommandMatcher = rule.command_regex !== undefined && rule.command_regex.length > 0;
	const hasEffectMatcher = rule.effects !== undefined && rule.effects.length > 0;

	if (!hasPathMatcher && !hasCommandMatcher && !hasEffectMatcher) return true;
	if (hasPathMatcher && !pathRuleMatches(rule.path_globs ?? [], unit)) return false;
	if (hasCommandMatcher && !commandRuleMatches(rule.command_regex ?? "", unit)) return false;
	if (hasEffectMatcher && !(rule.effects ?? []).some((effect) => unit.effects.includes(effect))) return false;
	return true;
}

function pathRuleMatches(globs: string[], unit: ApprovalUnit): boolean {
	if (unit.target.kind !== "path") return false;
	const target = normalizePath(unit.target.value);
	return globs.some((glob) => picomatch(normalizePath(glob), { dot: true, nonegate: true })(target));
}

function commandRuleMatches(rule: string, unit: ApprovalUnit): boolean {
	if (unit.target.kind !== "command") return false;
	return new RegExp(rule, "u").test(unit.target.match_value ?? unit.target.value);
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}
