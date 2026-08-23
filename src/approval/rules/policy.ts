import picomatch from "picomatch";

import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalRule, ApprovalUnit } from "../types.js";
import type { ApprovalRuleMatcher } from "./allow.js";

export function evaluateApproval(request: ApprovalRequest, config: ApprovalGateConfig, store: ApprovalRuleMatcher): ApprovalDecision {
	// 显式 deny 永远优先于会话或持久 allow。
	const deny = config.deny_rules.find((rule) => request.units.some((unit) => ruleMatchesUnit(rule, request.tool, unit)));
	if (deny !== undefined) return { kind: "deny", reason: deny.reason, rule_name: deny.name };

	const items: Extract<ApprovalDecision, { kind: "ask" }>["items"] = [];
	for (const unit of request.units) {
		// 显式 deny 已在上方检查；临时目录内的局部副作用不需要意图确认。
		if (unit.effect_scope === "temporary") continue;
		if (store.matchesAllowRule(request, unit)) continue;

		const ask = config.ask_rules.find((rule) => ruleMatchesUnit(rule, request.tool, unit));
		if (ask !== undefined) {
			items.push({ unit, reason: ask.reason });
			continue;
		}

		const defaultAction = config.defaults[request.tool];
		if (defaultAction === "deny") return { kind: "deny", reason: `default ${request.tool} approval policy` };
		if (defaultAction === "ask") items.push({ unit, reason: `default ${request.tool} approval policy` });
	}

	if (items.length === 0) return { kind: "allow" };
	const reasons = [...new Set(items.map((item) => item.reason))];
	return { kind: "ask", reason: reasons.join("; "), items };
}

export function ruleMatchesUnit(rule: ApprovalRule, tool: string, unit: ApprovalUnit): boolean {
	if (!rule.tools.includes(tool)) return false;

	const pathGlobs = rule.path_globs;
	if (pathGlobs !== undefined && pathGlobs.length > 0 && !pathRuleMatches(pathGlobs, unit)) return false;
	const commandRegex = rule.command_regex;
	if (commandRegex !== undefined && commandRegex.length > 0 && !commandRuleMatches(commandRegex, unit)) return false;
	return true;
}

function pathRuleMatches(globs: string[], unit: ApprovalUnit): boolean {
	if (unit.target.kind !== "path") return false;
	const target = normalizePath(unit.target.value);
	return globs.some((glob) => picomatch(normalizePath(glob), { dot: true, nonegate: true })(target));
}

function commandRuleMatches(rule: string, unit: ApprovalUnit): boolean {
	if (unit.target.kind !== "command") return false;
	const matcher = new RegExp(rule, "u");
	const direct = unit.target.match_value ?? unit.target.value;
	return matcher.test(direct)
		|| (unit.target.similar_value !== undefined && unit.target.similar_value !== direct && matcher.test(unit.target.similar_value));
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}
