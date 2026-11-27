import { readFileSync } from "node:fs";
import {
	CONFIG_DEFINITIONS,
	ConfigError,
	loadValidatedMergedConfig,
} from "../config-loader.ts";
import { resolvePathGlobs } from "./rules/path-match.ts";
import { agentSchemaPath } from "../runtime/paths.ts";
import { compile, type Validator } from "@earendil-works/pi-schema";
import type {
	ApprovalGateConfig, CommandRule, FileFact, NetworkFact, ShellCommandPrefix, ShellFactSettings,
	ShellPolicyCombination, ShellPolicyCommandMatcher, ShellPolicyFact, ShellScope, ToolPolicy,
} from "./types.ts";

const SCHEMA_PATH = agentSchemaPath("approval-gate.schema.json");
let validateComplete: Validator | undefined;

type ConfigStage = ShellCommandPrefix | { command: ShellCommandPrefix; arg_globs: string[] };
type ConfigMatcher = ShellScope & { platform?: "linux" | "darwin" | "win32" } & (CommandRule<string> | { pipeline: ConfigStage[] });
type ConfigShellFact = ShellFactSettings<string> & { commands?: Record<string, ConfigMatcher | false> };

type ShellPolicyFile = ToolPolicy<ConfigShellFact | false> & { combinations: Record<string, ShellPolicyCombination | false> };

interface ConfigFile extends Omit<ApprovalGateConfig, "tools"> {
	tools: {
		write: ToolPolicy<FileFact<string> | false>;
		edit: ToolPolicy<FileFact<string> | false>;
		webfetch: ToolPolicy<NetworkFact | false>;
		shell: ShellPolicyFile;
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
			write: compileTool(file.tools.write, compileFileFact),
			edit: compileTool(file.tools.edit, compileFileFact),
			webfetch: compileTool(file.tools.webfetch, fact => fact),
			shell: compileShellPolicy(file.tools.shell),
		},
	};
}

function compileFileFact(fact: FileFact<string>): FileFact {
	return "path_globs" in fact ? { ...fact, path_globs: resolvePathGlobs(fact.path_globs, "path") } : fact;
}

function compileTool<F extends object, R>(file: ToolPolicy<F | false>, compileFact: (fact: F) => R): ToolPolicy<R> {
	const facts: Record<string, R> = {};
	for (const [id, fact] of Object.entries(file.facts)) {
		if (fact !== false) facts[id] = compileFact(fact);
	}
	return { default_action: file.default_action, facts };
}

function compileCommand(rule: CommandRule<string>): CommandRule {
	const { arg_globs, ...prefix } = rule;
	return arg_globs ? { ...rule, arg_globs: resolvePathGlobs(arg_globs, "argument") } : prefix;
}

function compileMatcher(classifier: string, { shell, platform, ...rule }: ConfigMatcher): ShellPolicyCommandMatcher | undefined {
	if (platform !== undefined && platform !== process.platform) return;
	const scope = shell ? { classifier, shell } : { classifier };
	if ("pipeline" in rule) {
		const pipeline = rule.pipeline.map(stage => "command" in stage ? compileCommand(stage) : { command: stage });
		return { ...scope, pipeline };
	}
	return { ...scope, ...compileCommand(rule) };
}

function compileShellPolicy(file: ShellPolicyFile): ApprovalGateConfig["tools"]["shell"] {
	const facts: Record<string, ShellPolicyFact> = {};
	for (const [factId, fact] of Object.entries(file.facts)) {
		if (fact === false) continue;
		const { commands: rules = {}, path_globs, ...settings } = fact;
		const commands: ShellPolicyCommandMatcher[] = [];
		for (const [classifier, rule] of Object.entries(rules)) {
			if (rule === false) continue;
			const matcher = compileMatcher(classifier, rule);
			if (matcher) commands.push(matcher);
		}
		facts[factId] = { ...settings, commands, ...(path_globs && { path_globs: resolvePathGlobs(path_globs, "path") }) };
	}
	const combinations: Record<string, ShellPolicyCombination> = {};
	for (const [name, combination] of Object.entries(file.combinations)) {
		if (combination === false) continue;
		for (const factId of combination.all) {
			if (!Object.hasOwn(file.facts, factId)) {
				throw new ConfigError("approval shell policy combination references an unknown fact.", { combination: name, fact: factId });
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
		shellPolicy: ["default_action", "facts", "combinations"],
		shellCombination: ["all", "action"],
	})) schema.$defs[name] = { ...schema.$defs[name], required };
	for (const [name, selectors] of Object.entries({
		fileFact: ["path_globs", "match_all"], networkFact: ["network_scope", "match_all"], shellFact: ["commands", "path_globs", "match_all"],
	})) schema.$defs[name] = { ...schema.$defs[name], anyOf: selectors.map((key) => ({ required: [key] })) };
	const actionRequiresReason = {
		if: { required: ["action"] },
		then: { required: ["reason"], properties: { reason: { pattern: "\\S" } } },
	};
	for (const name of ["fileFact", "networkFact", "shellFact", "shellCombination"]) {
		schema.$defs[name] = { ...schema.$defs[name], allOf: [actionRequiresReason] };
	}
	schema.$defs.shellCommandMatcher = { ...schema.$defs.shellCommandMatcher, oneOf: [{ required: ["command"] }, { required: ["pipeline"] }] };
	return compile(schema);
}
