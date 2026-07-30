import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	expandHomePath,
	loadConfigLayers,
	mergeConfigValues,
	readDefaultJsoncConfigSync,
	validateConfigValue,
} from "../config-loader.js";
import type { ApprovalGateConfig, ApprovalRule } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("approval-gate.schema.json");

export class ApprovalConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ApprovalConfigError";
	}
}

export async function loadApprovalGateConfig(): Promise<ApprovalGateConfig> {
	const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.approvalGate, process.cwd(), createError);
	let merged: unknown = {};
	for (const layer of loaded.layers) {
		await validateConfigValue({
			path: layer.path,
			label: `approval-gate ${layer.kind}`,
			value: layer.value,
			layer: layer.kind,
			loadValidator: layer.kind === "default" ? loadCompleteValidator : loadValidator,
			createError,
		});
		merged = mergeConfigValues(merged, layer.value);
	}
	return materializeConfig(merged as CompleteApprovalGateConfig);
}

export function defaultApprovalGateConfig(): ApprovalGateConfig {
	return materializeConfig(readDefaultConfig());
}

interface RawApprovalGateConfig {
	enabled?: boolean;
	ui?: Partial<ApprovalGateConfig["ui"]>;
	remember?: Partial<ApprovalGateConfig["remember"]>;
	defaults?: Record<string, ApprovalGateConfig["defaults"][string]>;
	ask_rules?: ApprovalRule[];
	deny_rules?: ApprovalRule[];
}

interface CompleteApprovalGateConfig extends Required<RawApprovalGateConfig> {
	ui: ApprovalGateConfig["ui"];
	remember: ApprovalGateConfig["remember"];
}

function materializeConfig(raw: CompleteApprovalGateConfig): ApprovalGateConfig {
	const config: ApprovalGateConfig = {
		enabled: raw.enabled,
		ui: { ...raw.ui },
		remember: { ...raw.remember, persistent_store: expandHomePath(raw.remember.persistent_store) },
		defaults: { ...raw.defaults },
		ask_rules: cloneRules(raw.ask_rules),
		deny_rules: cloneRules(raw.deny_rules),
	};
	validateRules([...config.ask_rules, ...config.deny_rules]);
	return config;
}

function validateRules(rules: ApprovalRule[]): void {
	for (const rule of rules) {
		if (rule.command_regex === undefined) continue;
		try {
			new RegExp(rule.command_regex, "u");
		} catch (error) {
			throw new ApprovalConfigError("approval rule command_regex contains an invalid regular expression.", {
				rule: rule.name,
				command_regex: rule.command_regex,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function cloneRules(rules: ApprovalRule[]): ApprovalRule[] {
	return rules.map((rule) => ({
		name: rule.name,
		tools: [...rule.tools],
		...(rule.path_globs !== undefined ? { path_globs: [...rule.path_globs] } : {}),
		...(rule.command_regex !== undefined ? { command_regex: rule.command_regex } : {}),
		reason: rule.reason,
	}));
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
