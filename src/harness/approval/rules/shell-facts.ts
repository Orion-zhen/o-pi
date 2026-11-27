import { interpretCommand, type CommandView } from "./command-syntax.ts";
import { matchCommand, type Match } from "./command-match.ts";
import { matchesTargetPath, mayMatchWindowsPath } from "./path-match.ts";
import type {
	ApprovalUnit,
	ShellApprovalRequest,
	ShellPolicyCombination,
	ShellPolicyConfig,
	ShellPolicyFact,
	ShellScope,
} from "../types.ts";

interface ShellFactMatch {
	fact: string;
	classifier: string;
	unit: ApprovalUnit;
	config: ShellPolicyFact;
}

export interface ShellFactEvaluation {
	facts: string[];
	unresolved: Array<{ unit: ApprovalUnit; rule: string; reason: string }>;
	matches: ShellFactMatch[];
	combinations: Array<{ name: string; config: ShellPolicyCombination }>;
}

function matchPipeline(stages: CommandView[][], patterns: ReturnType<typeof matchCommand>[]): Match {
	// 可能命中的早期阶段不能遮住后面完整的确定匹配。
	let definite = 0, possible = 0;
	for (const stage of stages) {
		const result = patterns[definite]?.(stage);
		const candidate = possible === definite ? result : patterns[possible]?.(stage);
		if (candidate === "definite" || candidate === "possible") possible++;
		if (result === "definite" && ++definite === patterns.length) return "definite";
	}
	return possible === patterns.length ? "possible" : "none";
}

/** 只收集事实及组合，不处理放行记忆或生成审批决定。 */
export function collectShellFacts(
	request: ShellApprovalRequest,
	policy: ShellPolicyConfig,
): ShellFactEvaluation {
	const matchesShell = ({ shell }: ShellScope) => shell === undefined || shell === request.tool;
	const matches: ShellFactMatch[] = [];
	const possible: ShellFactMatch[] = [];
	const commands = request.units.flatMap((unit) => unit.commands ? [{ unit, views: unit.commands.map(interpretCommand) }] : []);
	const powerShell = request.tool === "powershell";
	const pipelines = request.pipelines.map(({ unit, stages }) => ({ unit, stages: stages.map((stage) => stage.map(interpretCommand)) }));
	for (const [factId, fact] of Object.entries(policy.facts)) {
		if (!matchesShell(fact)) continue;
		const add = (unit: ApprovalUnit, classifier: string, result: Match = "definite") => {
			if (result !== "none") (result === "definite" ? matches : possible).push({ fact: factId, classifier, unit, config: fact });
		};
		if (fact.match_all) {
			for (const unit of request.units) add(unit, "match_all");
		} else if (fact.path_globs) {
			for (const unit of request.units) {
				if (matchesTargetPath(unit.target, fact.path_globs)) add(unit, "path_globs");
				else if (unit.target.kind === "path" && unit.target.unmapped && fact.path_globs.some(mayMatchWindowsPath)) {
					add(unit, "path_globs", "possible");
				}
			}
		}
		for (const unit of request.units) if (unit.analysisFact === factId) add(unit, "analysis");
		for (const matcher of fact.commands) {
			if (!matchesShell(matcher)) continue;
			if ("pipeline" in matcher) {
				if (pipelines.length === 0) continue;
				const patterns = matcher.pipeline.map(stage => matchCommand(stage, powerShell));
				for (const { stages, unit } of pipelines) add(unit, matcher.classifier, matchPipeline(stages, patterns));
			} else {
				const matchesCommand = matchCommand(matcher, powerShell);
				for (const { unit, views } of commands) add(unit, matcher.classifier, matchesCommand(views));
			}
		}
	}
	const facts = [...new Set(matches.map((match) => match.fact))];
	const unresolved = possible.flatMap(({ fact, config, unit }) => config.action ? [{ unit, rule: fact, reason: config.reason }] : []);
	const combinations: ShellFactEvaluation["combinations"] = [];
	for (const [name, config] of Object.entries(policy.combinations)) {
		if (!matchesShell(config)) continue;
		const missing = config.all.filter(id => !facts.includes(id));
		if (!missing.length) combinations.push({ name, config });
		else if (missing.every(id => possible.some(m => m.fact === id))) {
			for (const { unit, fact } of possible) if (missing.includes(fact)) unresolved.push({ unit, rule: name, reason: config.reason });
		}
	}
	return { facts, matches, combinations, unresolved };
}
