import type {
	ApprovalDecision,
	ApprovalUnit,
	BashApprovalRequest,
	BashPolicyCombination,
	BashPolicyConfig,
	BashPolicyFact,
} from "../types.js";
import type { ApprovalRuleMatcher } from "./allow.js";

export interface BashFactMatch {
	fact: string;
	classifier: string;
	unit: ApprovalUnit;
	matched: string;
}

type BashPolicyDecision = Exclude<ApprovalDecision, { kind: "deny" }>
	| (Extract<ApprovalDecision, { kind: "deny" }> & { rule_name: string });

export interface BashPolicyEvaluation {
	decision: BashPolicyDecision;
	facts: string[];
	matches: BashFactMatch[];
	combinations: string[];
}

interface CollectedFactMatch extends BashFactMatch {
	action: BashPolicyFact["action"];
}

interface MatchedCombination {
	name: string;
	config: BashPolicyCombination;
}

export function evaluateBashPolicy(
	request: BashApprovalRequest,
	policy: BashPolicyConfig,
	store: ApprovalRuleMatcher,
	platform: NodeJS.Platform = process.platform,
): BashPolicyEvaluation {
	const matches = collectFactMatches(request, policy, platform);
	const facts = [...new Set(matches.map((match) => match.fact))];
	const matchedCombinations = matchingCombinations(policy, new Set(facts));
	const combinations = matchedCombinations.map(({ name }) => name);

	const deniedCombination = matchedCombinations.find(({ config }) => config.action === "deny");
	if (deniedCombination !== undefined) {
		return {
			decision: {
				kind: "deny",
				reason: `bash safety fact combination: ${deniedCombination.name}`,
				rule_name: deniedCombination.name,
			},
			facts,
			matches,
			combinations,
		};
	}

	const deniedFact = matches.find((match) => match.action === "deny");
	if (deniedFact !== undefined) {
		return {
			decision: {
				kind: "deny",
				reason: `bash safety fact: ${deniedFact.fact}`,
				rule_name: deniedFact.fact,
			},
			facts,
			matches,
			combinations,
		};
	}

	if (policy.default_action === "deny") {
		return {
			decision: { kind: "deny", reason: "default bash fact policy", rule_name: "default-bash-policy" },
			facts,
			matches,
			combinations,
		};
	}

	const askItems: Array<{ unit: ApprovalUnit; reason: string }> = [];
	for (const match of matches) {
		if (match.action !== "ask") continue;
		addAskItem(askItems, request, store, match.unit, `bash safety fact: ${match.fact}`);
	}
	for (const { name, config } of matchedCombinations) {
		if (config.action !== "ask") continue;
		const required = new Set(config.all);
		for (const match of matches) {
			if (required.has(match.fact)) addAskItem(askItems, request, store, match.unit, `bash safety fact combination: ${name}`);
		}
	}
	if (policy.default_action === "ask") {
		for (const unit of request.units) addAskItem(askItems, request, store, unit, "default bash fact policy");
	}

	if (askItems.length === 0) return { decision: { kind: "allow" }, facts, matches, combinations };
	return {
		decision: {
			kind: "ask",
			reason: [...new Set(askItems.map((item) => item.reason))].join("; "),
			items: askItems,
		},
		facts,
		matches,
		combinations,
	};
}

function collectFactMatches(
	request: BashApprovalRequest,
	policy: BashPolicyConfig,
	platform: NodeJS.Platform,
): CollectedFactMatch[] {
	const matches: CollectedFactMatch[] = [];
	for (const [factId, fact] of Object.entries(policy.facts)) {
		if (fact.enabled === false) continue;
		for (const [classifier, configuredRule] of Object.entries(fact.commands)) {
			if (configuredRule === false) continue;
			const matcher = typeof configuredRule === "string" ? { regex: configuredRule } : configuredRule;
			if (matcher.platform !== undefined && matcher.platform !== platform) continue;
			const regex = new RegExp(matcher.regex, "iu");
			if (matcher.scope === "raw-input") {
				const match = regex.exec(request.detail.command);
				if (match !== null) {
					matches.push({
						fact: factId,
						classifier,
						unit: rawInputUnit(request.detail.command),
						matched: match[0],
						action: fact.action,
					});
				}
				continue;
			}
			for (const unit of request.units) {
				if (unit.target.kind !== "command") continue;
				const candidate = matcher.scope === "effective-unit"
					? unit.target.similar_value ?? unit.target.match_value
					: unit.target.value;
				const match = regex.exec(candidate);
				if (match !== null) {
					matches.push({ fact: factId, classifier, unit, matched: match[0], action: fact.action });
				}
			}
		}
	}
	return matches;
}

function matchingCombinations(policy: BashPolicyConfig, facts: ReadonlySet<string>): MatchedCombination[] {
	const matches: MatchedCombination[] = [];
	for (const [name, config] of Object.entries(policy.combinations)) {
		if (config === false || config.enabled === false || !config.all.every((fact) => facts.has(fact))) continue;
		matches.push({ name, config });
	}
	return matches;
}

function addAskItem(
	items: Array<{ unit: ApprovalUnit; reason: string }>,
	request: BashApprovalRequest,
	store: ApprovalRuleMatcher,
	unit: ApprovalUnit,
	reason: string,
): void {
	if (unit.effect_scope === "temporary" || store.matchesAllowRule(request, unit)) return;
	const existing = items.find((item) => sameUnit(item.unit, unit));
	if (existing === undefined) {
		items.push({ unit, reason });
		return;
	}
	if (!existing.reason.split("; ").includes(reason)) existing.reason = `${existing.reason}; ${reason}`;
}

function sameUnit(left: ApprovalUnit, right: ApprovalUnit): boolean {
	return left.action === right.action
		&& left.target.kind === right.target.kind
		&& left.target.value === right.target.value;
}

function rawInputUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: command, match_value: command },
		remember: { session: true, persistent: false },
	};
}

export function formatBashPolicyEvaluation(
	evaluation: BashPolicyEvaluation,
	decision: ApprovalDecision,
): string {
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
			: ["", "Combinations:", ...evaluation.combinations.map((name) => `- ${name}`)]),
	].join("\n");
}
