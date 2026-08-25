import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	expandHomePath,
	loadValidatedMergedConfig,
	readDefaultJsoncConfigSync,
} from "../config-loader.js";
import type {
	ApprovalGateConfig,
	ApprovalRule,
	BashPolicyCommandMatcher,
	BashPolicyCommandRule,
	BashPolicyCombination,
	BashPolicyConfig,
	BashPolicyFact,
} from "./types.js";

const SCHEMA_PATH = agentSchemaPath("approval-gate.schema.json");

type RawBashPolicyCommandRule = string | false | Omit<BashPolicyCommandMatcher, "regex"> & { regex?: string };
type RawBashPolicyFact = Omit<BashPolicyFact, "commands"> & { commands?: Record<string, RawBashPolicyCommandRule> };
type RawBashPolicyCombination = Omit<BashPolicyCombination, "all" | "action"> & {
	all?: string[];
	action?: BashPolicyCombination["action"];
};
interface RawBashPolicyConfig extends Omit<BashPolicyConfig, "facts" | "combinations"> {
	facts: Record<string, RawBashPolicyFact>;
	combinations: Record<string, RawBashPolicyCombination | false>;
}

export class ApprovalConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ApprovalConfigError";
	}
}

export async function loadApprovalGateConfig(): Promise<ApprovalGateConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.approvalGate, process.cwd(), createError, { partial: loadValidator, complete: loadCompleteValidator },
	);
	return materializeConfig(loaded.merged as CompleteApprovalGateConfig);
}

export function defaultApprovalGateConfig(): ApprovalGateConfig {
	return materializeConfig(readDefaultConfig());
}

interface RawApprovalGateConfig {
	enabled?: boolean;
	ui?: Partial<ApprovalGateConfig["ui"]>;
	remember?: Partial<ApprovalGateConfig["remember"]>;
	tools?: {
		bash?: RawBashPolicyConfig;
		write?: ApprovalGateConfig["tools"]["write"];
		edit?: ApprovalGateConfig["tools"]["edit"];
	};
	ask_rules?: ApprovalRule[];
	deny_rules?: ApprovalRule[];
}

interface CompleteApprovalGateConfig extends Required<Omit<RawApprovalGateConfig, "tools">> {
	ui: ApprovalGateConfig["ui"];
	remember: ApprovalGateConfig["remember"];
	tools: {
		bash: RawBashPolicyConfig;
		write: ApprovalGateConfig["tools"]["write"];
		edit: ApprovalGateConfig["tools"]["edit"];
	};
}

function materializeConfig(raw: CompleteApprovalGateConfig): ApprovalGateConfig {
	return {
		...raw,
		remember: { ...raw.remember, persistent_store: expandHomePath(raw.remember.persistent_store) },
		tools: { ...raw.tools, bash: materializeBashPolicy(raw.tools.bash) },
	};
}

function materializeBashPolicy(raw: RawBashPolicyConfig): BashPolicyConfig {
	const factEntries: Array<[string, BashPolicyFact]> = [];
	for (const [factId, fact] of Object.entries(raw.facts)) {
		if (fact.commands === undefined) {
			throw new ApprovalConfigError("approval bash policy fact is incomplete.", { fact: factId });
		}
		const commandEntries = Object.entries(fact.commands).map(([classifier, rule]): [string, BashPolicyCommandRule] => [
			classifier,
			materializeCommandRule(factId, classifier, rule),
		]);
		factEntries.push([factId, { ...fact, commands: Object.fromEntries(commandEntries) }]);
	}

	const factIds = new Set(factEntries.map(([factId]) => factId));
	const combinationEntries: Array<[string, BashPolicyCombination | false]> = [];
	for (const [name, combination] of Object.entries(raw.combinations)) {
		if (combination === false) {
			combinationEntries.push([name, false]);
			continue;
		}
		if (combination.all === undefined || combination.action === undefined) {
			throw new ApprovalConfigError("approval bash policy combination is incomplete.", { combination: name });
		}
		for (const factId of combination.all) {
			if (!factIds.has(factId)) {
				throw new ApprovalConfigError("approval bash policy combination references an unknown fact.", {
					combination: name,
					fact: factId,
				});
			}
		}
		combinationEntries.push([name, { ...combination, all: combination.all, action: combination.action }]);
	}
	return {
		default_action: raw.default_action,
		facts: Object.fromEntries(factEntries),
		combinations: Object.fromEntries(combinationEntries),
	};
}

function materializeCommandRule(
	fact: string,
	classifier: string,
	rule: RawBashPolicyCommandRule,
): BashPolicyCommandRule {
	if (rule === false) return false;
	const source = typeof rule === "string" ? rule : rule.regex;
	if (source === undefined) {
		throw new ApprovalConfigError(`approval bash command matcher is incomplete: ${fact}/${classifier}.`, { fact, classifier });
	}
	try {
		new RegExp(source, "iu");
	} catch (error) {
		throw new ApprovalConfigError(`approval bash command regex is invalid: ${fact}/${classifier}.`, {
			fact,
			classifier,
			regex: source,
			error: String(error),
		});
	}
	return typeof rule === "string" ? rule : { ...rule, regex: source };
}

function readDefaultConfig(): CompleteApprovalGateConfig {
	return readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("approval-gate.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "approval-gate",
		createError,
	}) as CompleteApprovalGateConfig;
}

function createError(message: string, details?: Record<string, unknown>): ApprovalConfigError {
	return new ApprovalConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "approval-gate", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "approval-gate", createError });
