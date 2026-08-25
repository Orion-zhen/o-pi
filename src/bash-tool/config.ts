import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadValidatedMergedConfig,
	readDefaultJsoncConfigSync,
} from "../config-loader.js";
import type { BashToolConfig } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("bash-tool.schema.json");

export class BashConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "BashConfigError";
	}
}

/** 读取仓库内置的完整 bash 配置。 */
export function defaultBashToolConfig(): BashToolConfig {
	return materializeConfig(readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("bash-tool.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "bash-tool",
		createError,
	}) as BashToolConfig);
}

/** 读取独立 bash JSONC 配置。配置错误直接失败。 */
export async function loadBashToolConfig(): Promise<BashToolConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.bashTool, process.cwd(), createError, { partial: loadValidator, complete: loadCompleteValidator },
	);
	return materializeConfig(loaded.merged as BashToolConfig);
}

function materializeConfig(raw: BashToolConfig): BashToolConfig {
	validateEnvironment(raw.environment.remove_name_regex);
	return {
		default_timeout_seconds: raw.default_timeout_seconds,
		python_venv_paths: raw.python_venv_paths,
		environment: raw.environment,
		limits: raw.limits,
	};
}

function validateEnvironment(rules: readonly string[]): void {
	for (const rule of rules) {
		try {
			new RegExp(rule, process.platform === "win32" ? "iu" : "u");
		} catch (error) {
			throw new BashConfigError("bash environment remove_name_regex is invalid.", {
				regex: rule,
				error: String(error),
			});
		}
	}
}

function createError(message: string, details?: Record<string, unknown>): BashConfigError {
	return new BashConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "bash-tool", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "bash-tool", createError });
