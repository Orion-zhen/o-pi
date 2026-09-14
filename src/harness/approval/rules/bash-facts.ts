import type {
	ApprovalDecision,
	ApprovalUnit,
	BashApprovalRequest,
	BashPolicyCombination,
	BashPolicyConfig,
	BashPolicyFact,
} from "../types.js";

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
		remember: { session: true, persistent: false },
	};
	for (const [factId, fact] of Object.entries(policy.facts)) {
		for (const matcher of fact.commands) {
			if (matcher.platform !== undefined && matcher.platform !== process.platform) continue;
			const units = matcher.scope === "raw-input" ? [rawUnit] : request.units;
			for (const unit of units) {
				if (unit.target.kind !== "command") continue;
				const candidate = matcher.scope === "effective-unit" ? unit.target.effective_value : unit.target.value;
				if (matcher.regex.test(candidate)) matches.push({ fact: factId, classifier: matcher.classifier, unit, action: fact.action });
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

export function formatBashPolicyEvaluation(evaluation: BashFactEvaluation, decision: ApprovalDecision): string {
	return [
		`Decision: ${decision.kind}`,
		"",
		"Facts:",
		...(evaluation.facts.length === 0 ? ["- none"] : evaluation.facts.map((fact) => `- ${fact}`)),
		"",
		"Matches:",
		...(evaluation.matches.length === 0
			? ["- none"]
			: evaluation.matches.map((match) => `- ${match.fact} <- ${match.classifier}: ${match.unit.target.value}`)),
		...(evaluation.combinations.length === 0
			? []
			: ["", "Combinations:", ...evaluation.combinations.map(({ name }) => `- ${name}`)]),
	].join("\n");
}
