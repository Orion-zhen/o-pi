import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	findNearestProjectRoot as findNearestProjectRootBase,
	loadConfigLayers,
	readDefaultJsoncConfigSync,
	validateConfigValue,
} from "../config-loader.js";
import type { AgentOverride, SubagentConfig } from "./types.js";

const NUMBER_RANGES = {
	maxParallelTasks: [1, 32],
	maxConcurrency: [1, 8],
	timeoutMs: [1_000, 3_600_000],
	retries: [0, 5],
	retryDelayMs: [0, 60_000],
	maxInlineOutputTokens: [250, 50_000],
	maxHandoffTokens: [250, 50_000],
} as const;

const SCHEMA_PATH = agentSchemaPath("subagent.schema.json");
const PROJECT_SCHEMA_PATH = agentSchemaPath("subagent-project.schema.json");

export const findNearestProjectRoot = findNearestProjectRootBase;

export class SubagentConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "SubagentConfigError";
	}
}

/** 返回默认层配置。 */
export function defaultSubagentConfig(): SubagentConfig {
	return materializeDefaultConfig(readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("subagent.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "subagent",
		createError,
	}));
}

/** 加载用户与项目 JSONC 配置；项目配置只能覆盖普通运行参数。 */
export async function loadSubagentConfig(cwd = process.cwd()): Promise<SubagentConfig> {
	const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.subagent, cwd, createError);
	let merged: SubagentConfig | undefined;
	let sourcePath: string | undefined;
	for (const layer of loaded.layers) {
		await validateConfigValue({
			path: layer.path,
			label: `subagent ${layer.kind}`,
			value: layer.value,
			layer: layer.kind,
			loadValidator: layer.kind === "default" ? loadCompleteValidator : layer.kind === "project" ? loadProjectValidator : loadValidator,
			createError,
		});
		if (layer.kind === "default") merged = materializeDefaultConfig(layer.value);
		else if (merged !== undefined) merged = layer.kind === "project" ? mergeProjectConfig(merged, layer.value) : mergeUserConfig(merged, layer.value);
		sourcePath = layer.path;
	}
	if (merged === undefined) throw new SubagentConfigError("subagent default config is missing.");
	validateConfig(merged, sourcePath);
	return merged;
}

export function mergeUserConfig(base: SubagentConfig, raw: unknown): SubagentConfig {
	if (raw === undefined) return cloneConfig(base);
	const record = asRecord(raw, "subagent config");
	const next = cloneConfig(base);
	assignCommon(next, record);
	if ("default_model" in record) {
		const model = optionalString(record["default_model"], "default_model");
		if (model === undefined) delete next.defaultModel;
		else next.defaultModel = model;
	}
	if ("agent_scope" in record) {
		const scope = requireString(record["agent_scope"], "agent_scope");
		if (scope !== "user") throw new SubagentConfigError("agent_scope only supports user in this extension.");
	}
	if ("allow_project_agents" in record) next.allowProjectAgents = requireBoolean(record["allow_project_agents"], "allow_project_agents");
	if ("project_agents_override_user" in record) {
		next.projectAgentsOverrideUser = requireBoolean(record["project_agents_override_user"], "project_agents_override_user");
	}
	if ("confirm_write_agents" in record) next.confirmWriteAgents = requireBoolean(record["confirm_write_agents"], "confirm_write_agents");
	if ("default_tools" in record) next.defaultTools = requireToolList(record["default_tools"], "default_tools");
	if ("agent_overrides" in record) next.agentOverrides = parseOverrides(record["agent_overrides"]);
	return next;
}

export function mergeProjectConfig(userConfig: SubagentConfig, raw: unknown): SubagentConfig {
	if (raw === undefined) return cloneConfig(userConfig);
	const record = asRecord(raw, "project subagent config");
	const next = cloneConfig(userConfig);
	assignCommon(next, record);
	return next;
}

function assignCommon(target: SubagentConfig, record: Record<string, unknown>): void {
	if ("max_parallel_tasks" in record) target.maxParallelTasks = requireInteger(record["max_parallel_tasks"], "max_parallel_tasks");
	if ("max_concurrency" in record) target.maxConcurrency = requireInteger(record["max_concurrency"], "max_concurrency");
	if ("timeout_ms" in record) target.timeoutMs = requireInteger(record["timeout_ms"], "timeout_ms");
	if ("retries" in record) target.retries = requireInteger(record["retries"], "retries");
	if ("retry_delay_ms" in record) target.retryDelayMs = requireInteger(record["retry_delay_ms"], "retry_delay_ms");
	if ("retry_on_empty_output" in record) target.retryOnEmptyOutput = requireBoolean(record["retry_on_empty_output"], "retry_on_empty_output");
	if ("retry_on_timeout" in record) target.retryOnTimeout = requireBoolean(record["retry_on_timeout"], "retry_on_timeout");
	if ("max_inline_output_tokens" in record) {
		target.maxInlineOutputTokens = requireInteger(record["max_inline_output_tokens"], "max_inline_output_tokens");
	}
	if ("max_handoff_tokens" in record) target.maxHandoffTokens = requireInteger(record["max_handoff_tokens"], "max_handoff_tokens");
}

export function validateConfig(config: SubagentConfig, sourcePath?: string): void {
	for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
		const value = config[key as keyof typeof NUMBER_RANGES];
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
			throw new SubagentConfigError(`${key} is out of range.`, { path: sourcePath, min, max, value });
		}
	}
	if (config.defaultTools.length === 0) throw new SubagentConfigError("default_tools must not be empty.", { path: sourcePath });
}

function materializeDefaultConfig(raw: unknown): SubagentConfig {
	const record = asRecord(raw, "subagent default config");
	const scope = requireString(record["agent_scope"], "agent_scope");
	if (scope !== "user") throw new SubagentConfigError("agent_scope only supports user in this extension.");
	const config: SubagentConfig = {
		maxParallelTasks: requireInteger(record["max_parallel_tasks"], "max_parallel_tasks"),
		maxConcurrency: requireInteger(record["max_concurrency"], "max_concurrency"),
		timeoutMs: requireInteger(record["timeout_ms"], "timeout_ms"),
		retries: requireInteger(record["retries"], "retries"),
		retryDelayMs: requireInteger(record["retry_delay_ms"], "retry_delay_ms"),
		retryOnEmptyOutput: requireBoolean(record["retry_on_empty_output"], "retry_on_empty_output"),
		retryOnTimeout: requireBoolean(record["retry_on_timeout"], "retry_on_timeout"),
		maxInlineOutputTokens: requireInteger(record["max_inline_output_tokens"], "max_inline_output_tokens"),
		maxHandoffTokens: requireInteger(record["max_handoff_tokens"], "max_handoff_tokens"),
		agentScope: scope,
		allowProjectAgents: requireBoolean(record["allow_project_agents"], "allow_project_agents"),
		projectAgentsOverrideUser: requireBoolean(record["project_agents_override_user"], "project_agents_override_user"),
		confirmWriteAgents: requireBoolean(record["confirm_write_agents"], "confirm_write_agents"),
		defaultTools: requireToolList(record["default_tools"], "default_tools"),
		agentOverrides: parseOverrides(record["agent_overrides"]),
	};
	const model = optionalString(record["default_model"], "default_model");
	if (model !== undefined) config.defaultModel = model;
	return config;
}

function parseOverrides(value: unknown): Record<string, AgentOverride> {
	const record = asRecord(value, "agent_overrides");
	const result: Record<string, AgentOverride> = {};
	for (const [name, overrideValue] of Object.entries(record)) {
		const override = asRecord(overrideValue, `agent_overrides.${name}`);
		const parsed: AgentOverride = {};
		if ("model" in override) {
			const model = optionalString(override["model"], `agent_overrides.${name}.model`);
			if (model !== undefined) parsed.model = model;
		}
		if ("tools" in override) parsed.tools = requireToolList(override["tools"], `agent_overrides.${name}.tools`);
		result[name] = parsed;
	}
	return result;
}

function cloneConfig(config: SubagentConfig): SubagentConfig {
	return structuredClone(config);
}

function requireToolList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new SubagentConfigError(`${field} must be a non-empty string array.`);
	}
	return value.map((item) => item.trim());
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	throw new SubagentConfigError(`${field} must be a string or null.`);
}

function requireString(value: unknown, field: string): string {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	throw new SubagentConfigError(`${field} must be a non-empty string.`);
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value === "boolean") return value;
	throw new SubagentConfigError(`${field} must be boolean.`);
}

function requireInteger(value: unknown, field: string): number {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	throw new SubagentConfigError(`${field} must be an integer.`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new SubagentConfigError(`${field} must be an object.`);
}

function createError(message: string, details?: Record<string, unknown>): SubagentConfigError {
	return new SubagentConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "subagent", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "subagent", createError });
const loadProjectValidator = createSchemaValidator({ schemaPath: PROJECT_SCHEMA_PATH, label: "subagent project", createError });
