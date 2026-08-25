import picomatch from "picomatch";

import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalRule, ApprovalUnit } from "../types.js";
import type { ApprovalRuleMatcher } from "./allow.js";
import { evaluateBashPolicy, type BashPolicyEvaluation } from "./bash-facts.js";

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

		if (request.tool === "bash") continue;
		const defaultAction = config.tools[request.tool].default_action;
		if (defaultAction === "deny") return { kind: "deny", reason: `default ${request.tool} approval policy` };
		if (defaultAction === "ask") items.push({ unit, reason: `default ${request.tool} approval policy` });
	}

	if (items.length === 0) return { kind: "allow" };
	const reasons = [...new Set(items.map((item) => item.reason))];
	return { kind: "ask", reason: reasons.join("; "), items };
}

export function evaluateGatePolicy(
	request: ApprovalRequest,
	config: ApprovalGateConfig,
	store: ApprovalRuleMatcher,
): ApprovalDecision {
	return request.tool === "bash"
		? evaluateBashGatePolicy(request, config, store).decision
		: evaluateApproval(request, config, store);
}

export function evaluateBashGatePolicy(
	request: Extract<ApprovalRequest, { tool: "bash" }>,
	config: ApprovalGateConfig,
	store: ApprovalRuleMatcher,
): { decision: ApprovalDecision; bash: BashPolicyEvaluation } {
	const configured = evaluateApproval(request, config, store);
	const bash = evaluateBashPolicy(request, config.tools.bash, store);
	return { decision: mergeApprovalDecisions(configured, bash.decision), bash };
}

function mergeApprovalDecisions(left: ApprovalDecision, right: ApprovalDecision): ApprovalDecision {
	if (left.kind === "deny") return left;
	if (right.kind === "deny") return right;
	if (left.kind === "allow") return right;
	if (right.kind === "allow") return left;

	const items = [...left.items];
	for (const item of right.items) {
		const existing = items.find((candidate) => sameUnit(candidate.unit, item.unit));
		if (existing === undefined) {
			items.push(item);
			continue;
		}
		if (!existing.reason.split("; ").includes(item.reason)) existing.reason = `${existing.reason}; ${item.reason}`;
	}
	return {
		kind: "ask",
		reason: [...new Set(items.map((item) => item.reason))].join("; "),
		items,
	};
}

export function ruleMatchesUnit(rule: ApprovalRule, tool: string, unit: ApprovalUnit): boolean {
	if (!rule.tools.includes(tool)) return false;

	const pathGlobs = rule.path_globs;
	return pathGlobs === undefined || pathRuleMatches(pathGlobs, unit);
}

function pathRuleMatches(globs: string[], unit: ApprovalUnit): boolean {
	if (unit.target.kind !== "path") return false;
	const target = normalizePath(unit.target.value);
	return globs.some((glob) => picomatch(normalizePath(glob), { dot: true, nonegate: true })(target));
}

function sameUnit(left: ApprovalUnit, right: ApprovalUnit): boolean {
	return left.action === right.action && left.target.kind === right.target.kind && left.target.value === right.target.value;
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}
