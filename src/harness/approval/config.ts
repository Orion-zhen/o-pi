import { readFileSync } from "node:fs";
import {
	CONFIG_DEFINITIONS,
	ConfigError,
	loadValidatedMergedConfig,
} from "../config-loader.ts";
import { agentSchemaPath } from "../runtime/paths.ts";
import { compile, type Validator } from "@earendil-works/pi-schema";
import type { ApprovalGateConfig, BashFactSettings, BashMatcher, BashPolicyCommandMatcher, BashPolicyCombination, BashPolicyFact, FileFact, NetworkFact, ToolPolicy } from "./types.ts";

const SCHEMA_PATH = agentSchemaPath("approval-gate.schema.json");
let validateComplete: Validator | undefined;

type ConfigMatcher = BashMatcher & { platform?: "linux" | "darwin" | "win32" };
type ConfigBashFact = BashFactSettings & { commands?: Record<string, ConfigMatcher | false> };

interface ConfigFile extends Omit<ApprovalGateConfig, "tools"> {
	tools: {
		write: ToolPolicy<FileFact | false>;
		edit: ToolPolicy<FileFact | false>;
		webfetch: ToolPolicy<NetworkFact | false>;
		bash: ToolPolicy<ConfigBashFact | false> & {
			combinations: Record<string, BashPolicyCombination | false>;
		};
	};
}

export async function loadApprovalGateConfig(): Promise<ApprovalGateConfig> {
	const loaded = await loadValidatedMergedConfig(CONFIG_DEFINITIONS.approvalGate, process.cwd());
	return compileConfig(loaded.merged);
}

function compileConfig(value: unknown): ApprovalGateConfig {
	validateComplete ??= completeSchemaValidator();
	if (!validateComplete.check(value)) {
		throw new ConfigError("approval-gate merged config does not match schema.", { errors: validateComplete.errors(value) });
	}
	const file = value as ConfigFile;
	return {
		...file,
		tools: {
			write: compileTool(file.tools.write), edit: compileTool(file.tools.edit), webfetch: compileTool(file.tools.webfetch),
			bash: compileBashPolicy(file.tools.bash),
		},
	};
}

function compileTool<F extends object>(file: ToolPolicy<F | false>): ToolPolicy<F> {
	const facts: Record<string, F> = {};
	for (const [id, fact] of Object.entries(file.facts)) {
		if (fact !== false) facts[id] = fact;
	}
	return { default_action: file.default_action, facts };
}

function compileBashPolicy(file: ConfigFile["tools"]["bash"]): ApprovalGateConfig["tools"]["bash"] {
	const facts: Record<string, BashPolicyFact> = {};
	for (const [factId, fact] of Object.entries(file.facts)) {
		if (fact === false) continue;
		const commands: BashPolicyCommandMatcher[] = [];
		for (const [classifier, rule] of Object.entries(fact.commands ?? {})) {
			if (rule === false) continue;
			const { platform, ...matcher } = rule;
			if (platform === undefined || platform === process.platform) commands.push({ classifier, ...matcher });
		}
		facts[factId] = { ...fact, commands };
	}
	const combinations: Record<string, BashPolicyCombination> = {};
	for (const [name, combination] of Object.entries(file.combinations)) {
		if (combination === false) continue;
		for (const factId of combination.all) {
			if (!Object.hasOwn(file.facts, factId)) {
				throw new ConfigError("approval bash policy combination references an unknown fact.", { combination: name, fact: factId });
			}
		}
		if (combination.all.every((id) => Object.hasOwn(facts, id))) combinations[name] = combination;
	}
	return { default_action: file.default_action, facts, combinations };
}

/** 覆盖层允许只修改部分字段，合并后则要求所有运行时必需字段存在。 */
function completeSchemaValidator(): Validator {
	const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
		$defs: Record<string, object>;
	};
	for (const [name, required] of Object.entries({
		filePolicy: ["default_action", "facts"], networkPolicy: ["default_action", "facts"],
		fileFact: ["action"], networkFact: ["action"],
		bashPolicy: ["default_action", "facts", "combinations"],
		bashCombination: ["all", "action"],
	})) schema.$defs[name] = { ...schema.$defs[name], required };
	for (const [name, selectors] of Object.entries({
		fileFact: ["path_globs", "match_all"], networkFact: ["network_scope", "match_all"], bashFact: ["commands", "path_globs", "match_all"],
	})) schema.$defs[name] = { ...schema.$defs[name], anyOf: selectors.map((key) => ({ required: [key] })) };
	const actionRequiresReason = {
		if: { required: ["action"] },
		then: { required: ["reason"], properties: { reason: { pattern: "\\S" } } },
	};
	for (const name of ["fileFact", "networkFact", "bashFact", "bashCombination"]) {
		schema.$defs[name] = { ...schema.$defs[name], allOf: [actionRequiresReason] };
	}
	schema.$defs.bashCommandMatcher = { ...schema.$defs.bashCommandMatcher, oneOf: [{ required: ["command"] }, { required: ["pipeline"] }] };
	return compile(schema);
}
