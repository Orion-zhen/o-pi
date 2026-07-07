import { agentConfigPath, agentSchemaPath, createSchemaValidator, readOptionalJsoncConfigWithSchema } from "../config-loader.js";
import { PatternGuardConfigError, validatePatternGuardConfig } from "../safety/pattern-guard.js";
import type { BashToolConfig } from "./types.js";

const CONFIG_PATH_ENV = "PI_BASH_TOOL_CONFIG";

const defaultConfig: BashToolConfig = {
	version: 1,
	default_timeout_seconds: 120,
	limits: {
		success_output_bytes: 24_576,
		failure_output_bytes: 49_152,
		live_output_bytes: 8_192,
		max_capture_bytes: 268_435_456,
	},
	safety: {
		deny_patterns: ["rm -rf /", "rm -rf /*", "curl *|*sh", "wget *|*sh", "chmod -R 777 /", "chown -R * /"],
		deny_regex: [
			"\\brm\\s+-rf\\s+/(\\s|$)",
			"\\bmkfs(\\.|\\s|$)",
			"\\bdd\\s+.*\\bof=/dev/",
			":\\(\\)\\s*\\{\\s*:\\|:\\s*&\\s*\\}\\s*;",
			"\\b(curl|wget)\\b[\\s\\S]*\\|\\s*(sh|bash|zsh)\\b",
		],
	},
};

export class BashConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "BashConfigError";
	}
}

/** 读取独立 bash JSONC 配置；配置错误直接失败，避免静默使用不安全预算。 */
export async function loadBashToolConfig(): Promise<BashToolConfig> {
	const configPath = resolveConfigPath();
	const parsed = await readOptionalJsoncConfigWithSchema({
		path: configPath,
		label: "bash-tool",
		loadValidator,
		createError: (message, details) => new BashConfigError(message, details),
	});
	if (parsed === undefined) return defaultBashToolConfig();
	return mergeConfig(parsed as RawBashToolConfig);
}

export function defaultBashToolConfig(): BashToolConfig {
	return {
		version: 1,
		default_timeout_seconds: defaultConfig.default_timeout_seconds,
		limits: { ...defaultConfig.limits },
		safety: {
			deny_patterns: [...(defaultConfig.safety?.deny_patterns ?? [])],
			deny_regex: [...(defaultConfig.safety?.deny_regex ?? [])],
		},
	};
}

interface RawBashToolConfig {
	version: 1;
	default_timeout_seconds?: number;
	limits?: Partial<BashToolConfig["limits"]>;
	safety?: BashToolConfig["safety"];
}

function mergeConfig(raw: RawBashToolConfig): BashToolConfig {
	const merged: BashToolConfig = {
		version: 1,
		default_timeout_seconds: raw.default_timeout_seconds ?? defaultConfig.default_timeout_seconds,
		limits: {
			success_output_bytes: raw.limits?.success_output_bytes ?? defaultConfig.limits.success_output_bytes,
			failure_output_bytes: raw.limits?.failure_output_bytes ?? defaultConfig.limits.failure_output_bytes,
			live_output_bytes: raw.limits?.live_output_bytes ?? defaultConfig.limits.live_output_bytes,
			max_capture_bytes: raw.limits?.max_capture_bytes ?? defaultConfig.limits.max_capture_bytes,
		},
		safety: {
			deny_patterns: raw.safety?.deny_patterns ?? [...(defaultConfig.safety?.deny_patterns ?? [])],
			deny_regex: raw.safety?.deny_regex ?? [...(defaultConfig.safety?.deny_regex ?? [])],
		},
	};
	try {
		validatePatternGuardConfig(merged.safety);
	} catch (error) {
		if (error instanceof PatternGuardConfigError) {
			throw new BashConfigError(error.message, error.details);
		}
		throw error;
	}
	return merged;
}

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("bash-tool.schema.json"),
	label: "bash-tool",
	createError: (message, details) => new BashConfigError(message, details),
});

function resolveConfigPath(): string {
	return agentConfigPath("bash-tool.jsonc", CONFIG_PATH_ENV);
}
