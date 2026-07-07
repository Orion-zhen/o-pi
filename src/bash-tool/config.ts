import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

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

let compiledValidator: ValidateFunction | undefined;

export class BashConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "BashConfigError";
	}
}

/** 读取独立 bash JSONC 配置；配置错误直接失败，避免静默使用不安全预算。 */
export async function loadBashToolConfig(): Promise<BashToolConfig> {
	const configPath = resolveConfigPath();
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return defaultBashToolConfig();
		throw new BashConfigError("bash-tool config cannot be read.", { path: configPath });
	}

	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		throw new BashConfigError("bash-tool config is not valid JSONC.", {
			path: configPath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}

	const validator = await loadValidator();
	if (!validator(parsed)) {
		throw new BashConfigError("bash-tool config does not match schema.", {
			path: configPath,
			errors: validator.errors ?? [],
		});
	}

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

async function loadValidator(): Promise<ValidateFunction> {
	if (compiledValidator !== undefined) return compiledValidator;
	const schemaPath = path.join(projectRoot(), "agent", "schemas", "bash-tool.schema.json");
	let schema: object;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
	} catch {
		throw new BashConfigError("bash-tool schema cannot be read.", { path: schemaPath });
	}
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
	compiledValidator = ajv.compile(schema);
	return compiledValidator;
}

function resolveConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? path.join(projectRoot(), "agent", "configs", "bash-tool.jsonc");
}

function projectRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
