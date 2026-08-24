import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	loadValidatedMergedConfig,
} from "../config-loader.js";
import type { BashToolConfig } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("bash-tool.schema.json");

export class BashConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "BashConfigError";
	}
}

/** 读取独立 bash JSONC 配置；配置错误直接失败，避免静默使用不安全预算。 */
export async function loadBashToolConfig(): Promise<BashToolConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.bashTool, process.cwd(), createError, { partial: loadValidator, complete: loadCompleteValidator },
	);
	return materializeConfig(loaded.merged as BashToolConfig);
}

function materializeConfig(raw: BashToolConfig): BashToolConfig {
	for (const rule of raw.safety.deny_regex) {
		try {
			new RegExp(rule);
		} catch (error) {
			throw new BashConfigError("deny_regex contains an invalid regular expression.", {
				rule,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return {
		default_timeout_seconds: raw.default_timeout_seconds,
		python_venv_paths: raw.python_venv_paths,
		limits: raw.limits,
		safety: raw.safety,
	};
}

function createError(message: string, details?: Record<string, unknown>): BashConfigError {
	return new BashConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "bash-tool", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "bash-tool", createError });
