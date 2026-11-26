import { interpretCommand, type CommandView } from "./command-syntax.ts";
import { matchCommand } from "./command-match.ts";
import { matchesTargetPath } from "./path-match.ts";
import type {
	ApprovalUnit,
	BashApprovalRequest,
	BashPolicyCombination,
	BashPolicyConfig,
	BashPolicyFact,
} from "../types.ts";

interface BashFactMatch {
	fact: string;
	classifier: string;
	unit: ApprovalUnit;
	config: BashPolicyFact;
}

export interface BashFactEvaluation {
	facts: string[];
	matches: BashFactMatch[];
	combinations: Array<{ name: string; config: BashPolicyCombination }>;
}

function matchesPipeline(stages: CommandView[][], patterns: ReturnType<typeof matchCommand>[]): boolean {
	const remaining = stages.values();
	return patterns.every((match) => remaining.some((stage) => stage.some(match)));
}

/** 只收集事实及组合，不处理放行记忆或生成审批决定。 */
export function collectBashFacts(
	request: BashApprovalRequest,
	policy: BashPolicyConfig,
): BashFactEvaluation {
	const matches: BashFactMatch[] = [];
	const commands = request.units.flatMap((unit) => unit.commands ? [{ unit, views: unit.commands.map(interpretCommand) }] : []);
	const pipelines = request.pipelines.map(({ unit, stages }) => ({ unit, stages: stages.map((stage) => stage.map(interpretCommand)) }));
	for (const [factId, fact] of Object.entries(policy.facts)) {
		const add = (unit: ApprovalUnit, classifier: string) => matches.push({ fact: factId, classifier, unit, config: fact });
		if (fact.match_all) {
			for (const unit of request.units) add(unit, "match_all");
		} else if (fact.path_globs) {
			for (const unit of request.units) if (matchesTargetPath(unit.target, fact.path_globs)) add(unit, "path_globs");
		}
		for (const unit of request.units) if (unit.analysisFact === factId) add(unit, "analysis");
		for (const matcher of fact.commands) {
			if ("pipeline" in matcher) {
				const patterns = matcher.pipeline.map((stage) => matchCommand("command" in stage ? stage : { command: stage }));
				for (const { stages, unit } of pipelines) if (matchesPipeline(stages, patterns)) add(unit, matcher.classifier);
			} else {
				const matchesCommand = matchCommand(matcher);
				for (const { unit, views } of commands) if (views.some(matchesCommand)) add(unit, matcher.classifier);
			}
		}
	}
	const facts = [...new Set(matches.map((match) => match.fact))];
	const combinations = Object.entries(policy.combinations)
		.flatMap(([name, config]) => config.all.every((fact) => facts.includes(fact))
			? [{ name, config }]
			: []);
	return { facts, matches, combinations };
}
