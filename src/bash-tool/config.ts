import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	loadValidatedMergedConfig,
} from "../config-loader.js";
import type { BashToolConfig } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("bash-tool.schema.json");

class BashConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "BashConfigError";
	}
}

/** 读取独立 bash JSONC 配置。配置错误直接失败。 */
export async function loadBashToolConfig(): Promise<BashToolConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.bashTool, process.cwd(), createError, { partial: loadValidator, complete: loadCompleteValidator },
	);
	const { $schema: _schema, ...config } = loaded.merged as BashToolConfig & { $schema?: string };
	validateEnvironment(config.environment.remove_name_regex);
	return config;
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
