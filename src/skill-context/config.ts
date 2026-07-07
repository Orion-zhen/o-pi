import { agentConfigPath, agentSchemaPath, createSchemaValidator, readOptionalJsoncConfigWithSchema } from "../config-loader.js";
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

export class SkillContextConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "SkillContextConfigError";
	}
}

/** 读取 host-side skill context JSONC 配置；配置错误直接失败，避免 skill 行为静默降级。 */
export async function loadSkillContextConfig(): Promise<SkillContextConfig> {
	const configPath = resolveConfigPath();
	const parsed = await readOptionalJsoncConfigWithSchema({
		path: configPath,
		label: "skill-context",
		loadValidator,
		createError: (message, details) => new SkillContextConfigError(message, details),
	});
	if (parsed === undefined) return defaultSkillContextConfig();
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

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("skill-context.schema.json"),
	label: "skill-context",
	createError: (message, details) => new SkillContextConfigError(message, details),
});

function resolveConfigPath(): string {
	return agentConfigPath("skill-context.jsonc", CONFIG_PATH_ENV);
}
