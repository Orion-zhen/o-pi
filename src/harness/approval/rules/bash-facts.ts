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
	action: BashPolicyFact["action"];
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
	const rawUnit: ApprovalUnit = {
		action: "execute",
		target: { kind: "command", value: request.detail.command, effective_value: request.detail.command },
		remember: true,
	};
	const inputs = [rawUnit, ...request.units.filter(({ target }) => target.kind === "command" && target.shell_input !== undefined)];
	for (const [factId, fact] of Object.entries(policy.facts)) {
		for (const matcher of fact.commands) {
			if (matcher.platform !== undefined && matcher.platform !== process.platform) continue;
			const units = matcher.scope === "raw-input" ? inputs : request.units;
			for (const unit of units) {
				if (unit.target.kind !== "command") continue;
				const candidate = matcher.scope === "raw-input" ? unit.target.shell_input ?? unit.target.value
					: matcher.scope === "effective-unit" ? unit.target.effective_value : unit.target.value;
				const resolved = matcher.scope === "source-unit" ? unit.target.resolved_value : undefined;
				if (matcher.regex.test(candidate) || resolved !== undefined && (matcher.regex.test(resolved) || matcher.regex.test(unit.target.effective_value))) {
					matches.push({ fact: factId, classifier: matcher.classifier, unit, action: fact.action });
				}
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
