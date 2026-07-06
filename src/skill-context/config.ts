import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { SkillContextConfig } from "./types.js";

const CONFIG_PATH_ENV = "PI_SKILL_CONTEXT_CONFIG";

const defaultConfig: SkillContextConfig = {
	version: 1,
	enabled: true,
	max_active: 1,
	on_load_conflict: "replace",
	clear_mode: "lazy",
	dedupe_read: true,
	max_body_chars: 20_000,
};

let compiledValidator: ValidateFunction | undefined;

export class SkillContextConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "SkillContextConfigError";
	}
}

/** 读取 host-side skill context JSONC 配置；配置错误直接失败，避免 skill 行为静默降级。 */
export async function loadSkillContextConfig(): Promise<SkillContextConfig> {
	const configPath = resolveConfigPath();
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return defaultSkillContextConfig();
		throw new SkillContextConfigError("skill-context config cannot be read.", { path: configPath });
	}

	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		throw new SkillContextConfigError("skill-context config is not valid JSONC.", {
			path: configPath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}

	const validator = await loadValidator();
	if (!validator(parsed)) {
		throw new SkillContextConfigError("skill-context config does not match schema.", { path: configPath, errors: validator.errors ?? [] });
	}
	return mergeConfig(parsed as RawSkillContextConfig);
}

export function defaultSkillContextConfig(): SkillContextConfig {
	return { ...defaultConfig };
}

interface RawSkillContextConfig {
	version: 1;
	enabled?: boolean;
	max_active?: number;
	on_load_conflict?: SkillContextConfig["on_load_conflict"];
	clear_mode?: SkillContextConfig["clear_mode"];
	dedupe_read?: boolean;
	max_body_chars?: number;
}

function mergeConfig(raw: RawSkillContextConfig): SkillContextConfig {
	const merged: SkillContextConfig = {
		version: 1,
		enabled: raw.enabled ?? defaultConfig.enabled,
		max_active: raw.max_active ?? defaultConfig.max_active,
		on_load_conflict: raw.on_load_conflict ?? defaultConfig.on_load_conflict,
		clear_mode: raw.clear_mode ?? defaultConfig.clear_mode,
		dedupe_read: raw.dedupe_read ?? defaultConfig.dedupe_read,
		max_body_chars: raw.max_body_chars ?? defaultConfig.max_body_chars,
	};
	if (merged.max_active < 1) throw new SkillContextConfigError("max_active must be at least 1.");
	return merged;
}

async function loadValidator(): Promise<ValidateFunction> {
	if (compiledValidator !== undefined) return compiledValidator;
	const schemaPath = path.join(projectRoot(), "agent", "schemas", "skill-context.schema.json");
	let schema: object;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
	} catch {
		throw new SkillContextConfigError("skill-context schema cannot be read.", { path: schemaPath });
	}
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
	compiledValidator = ajv.compile(schema);
	return compiledValidator;
}

function resolveConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? path.join(projectRoot(), "agent", "configs", "skill-context.jsonc");
}

function projectRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

