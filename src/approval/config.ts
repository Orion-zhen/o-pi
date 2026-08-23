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
import type { ApprovalGateConfig, ApprovalRule } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("approval-gate.schema.json");

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
	defaults?: Record<string, ApprovalGateConfig["defaults"][string]>;
	ask_rules?: ApprovalRule[];
	deny_rules?: ApprovalRule[];
}

interface CompleteApprovalGateConfig extends Required<RawApprovalGateConfig> {
	ui: ApprovalGateConfig["ui"];
	remember: ApprovalGateConfig["remember"];
}

function materializeConfig(raw: CompleteApprovalGateConfig): ApprovalGateConfig {
	validateRules([...raw.ask_rules, ...raw.deny_rules]);
	return {
		...raw,
		remember: { ...raw.remember, persistent_store: expandHomePath(raw.remember.persistent_store) },
	};
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
