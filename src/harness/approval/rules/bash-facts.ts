import path from "node:path/posix";
import picomatch from "picomatch";
import { matchesTargetPath } from "./path-match.ts";
import { builtinCommandFacts, builtinPipelineFacts } from "./bash-builtin-facts.ts";
import type {
	BashArgv,
	BashCommandPrefix,
	ApprovalUnit,
	BashApprovalRequest,
	BashPolicyCombination,
	BashPolicyConfig,
	BashPolicyFact,
} from "../types.ts";

function matchPrefix([program, ...args]: BashCommandPrefix): (argv: BashArgv) => boolean {
	const serviceControl = process.platform === "win32" && /^sc(?:\.exe)?$/iu.test(program);
	const matchesProgram = picomatch(program, { dot: true, nonegate: true, nocase: serviceControl });
	return (argv) => matchesProgram(argv[0]) && args.every((word, i) => {
		const arg = argv[i + 1];
		return arg === word || serviceControl && i === 0 && typeof arg === "string" && arg.toLowerCase() === word.toLowerCase();
	});
}

interface BashFactMatch {
	fact: string;
	classifier: string;
	unit: ApprovalUnit;
	action: BashPolicyFact["action"];
	reason: string;
}

export interface BashFactEvaluation {
	facts: string[];
	matches: BashFactMatch[];
	combinations: Array<{ name: string; config: BashPolicyCombination }>;
}

/** 只收集事实及组合，不处理放行记忆或生成审批决定。 */
export function collectBashFacts(
	request: BashApprovalRequest,
	policy: BashPolicyConfig,
): BashFactEvaluation {
	const matches: BashFactMatch[] = [];
	const analyzed = request.units.map((unit) => {
		const facts: string[] = unit.commands?.flatMap(builtinCommandFacts) ?? [];
		if (unit.analysisFact) facts.push(unit.analysisFact);
		return { unit, facts };
	});
	for (const pipe of request.pipelines) analyzed.push({ unit: pipe.unit, facts: builtinPipelineFacts(pipe) });
	for (const [factId, fact] of Object.entries(policy.facts)) {
		const reason = fact.reason ?? `bash safety fact: ${factId}`;
		const add = (unit: ApprovalUnit, classifier: string) => matches.push({ fact: factId, classifier, unit, action: fact.action, reason });
		if (fact.match_all) {
			for (const unit of request.units) add(unit, "match_all");
		} else if (fact.path_globs) {
			for (const unit of request.units) if (matchesTargetPath(unit.target, fact.path_globs)) add(unit, "path_globs");
		}
		for (const { unit, facts } of analyzed) if (facts.includes(factId)) add(unit, "analysis");
		for (const matcher of fact.commands) {
			if ("pipeline" in matcher) {
				const patterns = matcher.pipeline.map(matchPrefix);
				for (const { stages, unit } of request.pipelines) {
					if (stages.some((_, start) => patterns.every((matches, offset) => stages[start + offset]?.some(matches)))) add(unit, matcher.classifier);
				}
				continue;
			}
			const prefix = matchPrefix(matcher.command);
			const glob = matcher.arg_globs && picomatch(matcher.arg_globs, { dot: true, nonegate: true });
			for (const unit of request.units) {
				if (unit.commands?.some((argv) => prefix(argv) && (!matcher.exact || argv.length === matcher.command.length)
					&& (!glob || argv.slice(matcher.command.length).some((arg) => {
						const text = typeof arg === "string" ? arg : arg.source.replace(/^["']|["']$/gu, "");
						return glob(text) || glob(path.normalize(text.replaceAll("\\", "/")));
					})))) add(unit, matcher.classifier);
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
