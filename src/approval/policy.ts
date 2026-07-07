import picomatch from "picomatch";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalRule } from "./types.js";
import type { ApprovalStore } from "./store.js";

export function evaluateApproval(request: ApprovalRequest, config: ApprovalGateConfig, store: ApprovalStore): ApprovalDecision {
	if (!config.enabled) return { kind: "allow" };
	if (store.matchesAllowRule(request)) return { kind: "allow" };

	const deny = config.deny_rules.find((rule) => ruleMatchesRequest(rule, request));
	if (deny !== undefined) return { kind: "deny", reason: deny.reason, rule_name: deny.name };

	const ask = config.ask_rules.find((rule) => ruleMatchesRequest(rule, request));
	if (ask !== undefined) return { kind: "ask", reason: ask.reason, rule_name: ask.name };

	const defaultAction = config.defaults[request.tool];
	if (defaultAction === "ask") return { kind: "ask", reason: `default ${request.tool} approval policy` };
	if (defaultAction === "deny") return { kind: "deny", reason: `default ${request.tool} approval policy` };
	return { kind: "allow" };
}

export function ruleMatchesRequest(rule: ApprovalRule, request: ApprovalRequest): boolean {
	if (!rule.tools.includes(request.tool)) return false;

	const hasPathMatcher = rule.path_globs !== undefined && rule.path_globs.length > 0;
	const hasCommandMatcher = rule.command_regex !== undefined && rule.command_regex.length > 0;
	const hasEffectMatcher = rule.effects !== undefined && rule.effects.length > 0;

	if (!hasPathMatcher && !hasCommandMatcher && !hasEffectMatcher) return true;

	if (hasPathMatcher && !pathRuleMatches(rule.path_globs ?? [], request)) return false;
	if (hasCommandMatcher && !commandRuleMatches(rule.command_regex ?? "", request)) return false;
	if (hasEffectMatcher && !(rule.effects ?? []).some((effect) => request.effects.includes(effect))) return false;
	return true;
}

function pathRuleMatches(globs: string[], request: ApprovalRequest): boolean {
	const pathTargets = request.targets.filter((target) => target.kind === "path").map((target) => normalizePath(target.value));
	return globs.some((glob) => {
		const matcher = picomatch(normalizePath(glob), { dot: true, nonegate: true });
		return pathTargets.some((target) => matcher(target));
	});
}

function commandRuleMatches(rule: string, request: ApprovalRequest): boolean {
	const commandTargets = request.targets.filter((target) => target.kind === "command").map((target) => target.value);
	const regex = new RegExp(rule, "u");
	return commandTargets.some((command) => regex.test(command));
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}
