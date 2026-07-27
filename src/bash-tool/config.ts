import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadConfigLayers,
	mergeConfigValues,
	readDefaultJsoncConfigSync,
	validateConfigValue,
} from "../config-loader.js";
import { PatternGuardConfigError, validatePatternGuardConfig } from "./pattern-guard.js";
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
	const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.bashTool, process.cwd(), createError);
	let merged: unknown = {};
	for (const layer of loaded.layers) {
		await validateConfigValue({
			path: layer.path,
			label: `bash-tool ${layer.kind}`,
			value: layer.value,
			layer: layer.kind,
			loadValidator: layer.kind === "default" ? loadCompleteValidator : loadValidator,
			createError,
		});
		merged = mergeConfigValues(merged, layer.value);
	}
	return materializeConfig(merged as CompleteBashToolConfig);
}

export function defaultBashToolConfig(): BashToolConfig {
	return materializeConfig(readDefaultConfig());
}

interface RawBashToolConfig {
	default_timeout_seconds?: number;
	limits?: Partial<BashToolConfig["limits"]>;
	safety?: BashToolConfig["safety"];
}

interface CompleteBashToolConfig extends Required<RawBashToolConfig> {
	limits: BashToolConfig["limits"];
	safety: Required<NonNullable<BashToolConfig["safety"]>>;
}

function materializeConfig(raw: CompleteBashToolConfig): BashToolConfig {
	const config: BashToolConfig = {
		default_timeout_seconds: raw.default_timeout_seconds,
		limits: { ...raw.limits },
		safety: { deny_patterns: [...raw.safety.deny_patterns], deny_regex: [...raw.safety.deny_regex] },
	};
	try {
		validatePatternGuardConfig(config.safety);
	} catch (error) {
		if (error instanceof PatternGuardConfigError) throw new BashConfigError(error.message, error.details);
		throw error;
	}
	return config;
}

function readDefaultConfig(): CompleteBashToolConfig {
	return readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("bash-tool.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "bash-tool",
		createError,
	}) as CompleteBashToolConfig;
}

function createError(message: string, details?: Record<string, unknown>): BashConfigError {
	return new BashConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "bash-tool", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "bash-tool", createError });
