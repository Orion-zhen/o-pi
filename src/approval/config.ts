import { readFileSync } from "node:fs";
import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	expandHomePath,
	loadValidatedMergedConfig,
} from "../config-loader.js";
import { compileSchemaValidator, type SchemaValidateFunction } from "../schema-validator.js";
import type { ApprovalGateConfig, BashPolicyCommandMatcher, BashPolicyCombination, BashPolicyConfig, BashPolicyFact } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("approval-gate.schema.json");
const schemaOptions = { schemaPath: SCHEMA_PATH, label: "approval-gate", createError };
const loadValidator = createSchemaValidator(schemaOptions);
const loadDefaultValidator = createCompleteSchemaValidator(schemaOptions);
let validateComplete: SchemaValidateFunction | undefined;

type FileCommandRule = string | false | {
	regex: string;
	scope?: BashPolicyCommandMatcher["scope"];
	platform?: BashPolicyCommandMatcher["platform"];
};
interface ConfigFile extends Omit<ApprovalGateConfig, "tools"> {
	tools: Omit<ApprovalGateConfig["tools"], "bash"> & {
		bash: {
			default_action: BashPolicyConfig["default_action"];
			facts: Record<string, {
				enabled?: boolean;
				action?: BashPolicyFact["action"];
				commands: Record<string, FileCommandRule>;
			}>;
			combinations: Record<string, false | BashPolicyCombination & { enabled?: boolean }>;
		};
	};
}

class ApprovalConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ApprovalConfigError";
	}
}

export async function loadApprovalGateConfig(): Promise<ApprovalGateConfig> {
	const loaded = await loadValidatedMergedConfig(CONFIG_DEFINITIONS.approvalGate, process.cwd(), createError, {
		partial: loadValidator, complete: loadDefaultValidator,
	});
	return compileConfig(loaded.merged);
}

function compileConfig(value: unknown): ApprovalGateConfig {
	validateComplete ??= completeSchemaValidator();
	if (!validateComplete(value)) {
		throw new ApprovalConfigError("approval-gate merged config does not match schema.", { errors: validateComplete.errors });
	}
	const file = value as ConfigFile;
	return {
		...file,
		remember: { ...file.remember, persistent_store: expandHomePath(file.remember.persistent_store) },
		tools: { ...file.tools, bash: compileBashPolicy(file.tools.bash) },
	};
}

function compileBashPolicy(file: ConfigFile["tools"]["bash"]): BashPolicyConfig {
	const facts: Record<string, BashPolicyFact> = {};
	for (const [factId, fact] of Object.entries(file.facts)) {
		const commands: BashPolicyCommandMatcher[] = [];
		for (const [classifier, rule] of Object.entries(fact.commands)) {
			if (rule === false) continue;
			const matcher = typeof rule === "string" ? { regex: rule } : rule;
			let regex: RegExp;
			try {
				regex = new RegExp(matcher.regex, "iu");
			} catch (error) {
				throw new ApprovalConfigError(`approval bash command regex is invalid: ${factId}/${classifier}.`, {
					fact: factId, classifier, regex: matcher.regex, error: String(error),
				});
			}
			commands.push({ classifier, regex, scope: matcher.scope ?? "source-unit", ...(matcher.platform === undefined ? {} : { platform: matcher.platform }) });
		}
		if (fact.enabled !== false) facts[factId] = { commands, ...(fact.action === undefined ? {} : { action: fact.action }) };
	}
	const combinations: Record<string, BashPolicyCombination> = {};
	for (const [name, combination] of Object.entries(file.combinations)) {
		if (combination === false) continue;
		for (const factId of combination.all) {
			if (!Object.hasOwn(file.facts, factId)) {
				throw new ApprovalConfigError("approval bash policy combination references an unknown fact.", { combination: name, fact: factId });
			}
		}
		if (combination.enabled !== false) combinations[name] = { all: combination.all, action: combination.action };
	}
	return { default_action: file.default_action, facts, combinations };
}

/** 覆盖层允许只修改部分字段，合并后则要求所有运行时必需字段存在。 */
function completeSchemaValidator(): SchemaValidateFunction {
	const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
		required: string[];
		properties: Record<string, object>;
		$defs: Record<string, object>;
	};
	schema.required = ["enabled", "ui", "remember", "tools", "ask_rules", "deny_rules"];
	for (const [name, required] of Object.entries({
		ui: ["timeout_ms", "non_interactive"],
		remember: ["allow_session", "allow_persistent", "persistent_store"],
		tools: ["bash", "write", "edit", "webfetch"],
	})) schema.properties[name] = { ...schema.properties[name], required };
	for (const [name, required] of Object.entries({
		toolPolicy: ["default_action"],
		bashPolicy: ["default_action", "facts", "combinations"],
		bashFact: ["commands"],
		bashCommandMatcher: ["regex"],
		bashCombination: ["all", "action"],
	})) schema.$defs[name] = { ...schema.$defs[name], required };
	return compileSchemaValidator(schema, { allErrors: true });
}

function createError(message: string, details?: Record<string, unknown>): ApprovalConfigError {
	return new ApprovalConfigError(message, details);
}
