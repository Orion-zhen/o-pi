import path from "node:path";
import picomatch from "picomatch";

import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest, ApprovalRule, ApprovalUnit, BashApprovalRequest, NumericFileName } from "../types.ts";
import type { ApprovalRuleMatcher } from "./store.ts";
import { collectBashFacts, type BashFactEvaluation } from "./bash-facts.ts";

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

function mayMatchNumericName(pattern: string, { prefix, suffix }: NumericFileName): boolean {
	const first = pattern.search(/[*?]/u);
	if (first < 0) {
		return pattern.startsWith(prefix) && pattern.endsWith(suffix) && pattern.length >= prefix.length + suffix.length
			&& /^\d*$/u.test(pattern.slice(prefix.length, pattern.length - suffix.length));
	}
	const start = pattern.slice(0, first);
	const end = pattern.slice(Math.max(pattern.lastIndexOf("*"), pattern.lastIndexOf("?")) + 1);
	return (start.startsWith(prefix) || prefix.startsWith(start)) && (end.endsWith(suffix) || suffix.endsWith(end));
}

function mayMatchChild(glob: string, directory: string, numericName?: NumericFileName): boolean {
	if (numericName !== undefined && /^[\p{L}\p{M}\p{N}_ ./:*?-]+$/u.test(glob)) {
		const fold = (value: string) => path.sep === "\\" ? value.toLowerCase() : value;
		if (!/[*?]/u.test(glob) && fold(path.dirname(glob)) !== fold(directory)) return false;
		if (!mayMatchNumericName(fold(path.posix.basename(glob)), { prefix: fold(numericName.prefix), suffix: fold(numericName.suffix) })) return false;
	}
	// 只在能证明父目录不相交时排除规则。复杂模式不拿展示用的文件名去匹配。
	if (!/^\/[\w./*?-]+$/u.test(glob)) return true;
	const parent = glob.slice(0, glob.lastIndexOf("/")) || "/";
	if (!glob.includes("**")) return picomatch(parent, { dot: true, nonegate: true })(directory);
	const prefix = glob.split(/[*?]/u, 1)[0] ?? "";
	const root = prefix.slice(0, prefix.lastIndexOf("/"));
	return directory === root || directory.startsWith(`${root}/`) || path.posix.dirname(root) === directory;
}

function ruleMatchesUnit(rule: ApprovalRule, tool: string, unit: ApprovalUnit): boolean {
	if (!rule.tools.includes(tool)) return false;
	if (rule.path_globs === undefined) return true;
	const target = unit.target;
	if (target.kind !== "path") return false;
	return rule.path_globs.some((pattern) => {
		const glob = pattern.replace(/\\/g, "/");
		if (target.directory === undefined) return picomatch(glob, { dot: true, nonegate: true })(target.value.replace(/\\/g, "/"));
		return mayMatchChild(glob, target.directory, target.numericName);
	});
}
