import { findNearestProjectRoot as findNearestProjectRootBase, projectAgentConfigPath, readOptionalJsoncConfig, userAgentConfigPath } from "../config-loader.js";
import type { AgentOverride, OutputMode, SubagentConfig } from "./types.js";

const USER_CONFIG_ENV = "PI_SUBAGENT_USER_CONFIG";
const PROJECT_CONFIG_ENV = "PI_SUBAGENT_PROJECT_CONFIG";
const PROJECT_ROOT_ENV = "PI_SUBAGENT_PROJECT_ROOT";

const NUMBER_RANGES = {
	maxParallelTasks: [1, 32],
	maxConcurrency: [1, 8],
	timeoutMs: [1_000, 3_600_000],
	retries: [0, 5],
	retryDelayMs: [0, 60_000],
	maxInlineOutputChars: [1_000, 200_000],
	maxHandoffChars: [1_000, 200_000],
} as const;

export const findNearestProjectRoot = findNearestProjectRootBase;

export class SubagentConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "SubagentConfigError";
	}
}

/** 返回内置默认配置；默认并发为 1，适合单 GPU 本地模型。 */
export function defaultSubagentConfig(): SubagentConfig {
	return {
		maxParallelTasks: 4,
		maxConcurrency: 1,
		timeoutMs: 600_000,
		retries: 1,
		retryDelayMs: 1_000,
		retryOnEmptyOutput: true,
		retryOnTimeout: false,
		maxInlineOutputChars: 12_000,
		maxHandoffChars: 16_000,
		outputMode: "inline",
		agentScope: "user",
		allowProjectAgents: false,
		projectAgentsOverrideUser: false,
		confirmWriteAgents: true,
		defaultTools: ["read", "grep", "find", "ls"],
		agentOverrides: {
			scout: { tools: ["read", "grep", "find", "ls"] },
			planner: { tools: ["read", "grep", "find", "ls"] },
			reviewer: { tools: ["read", "grep", "find", "ls", "bash"] },
			worker: { tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
		},
	};
}

/** 加载用户与项目 JSONC 配置；项目配置只能覆盖普通运行参数。 */
export async function loadSubagentConfig(cwd = process.cwd()): Promise<SubagentConfig> {
	const defaults = defaultSubagentConfig();
	const userPath = userConfigPath();
	const userRaw = await readOptionalConfig(userPath);
	const userMerged = mergeUserConfig(defaults, userRaw?.value);
	validateConfig(userMerged, userPath);

	const projectPath = projectConfigPath(cwd);
	const projectRaw = projectPath === undefined ? undefined : await readOptionalConfig(projectPath);
	const merged = mergeProjectConfig(userMerged, projectRaw?.value);
	validateConfig(merged, projectPath ?? userPath);
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
	if ("max_inline_output_chars" in record) {
		target.maxInlineOutputChars = requireInteger(record["max_inline_output_chars"], "max_inline_output_chars");
	}
	if ("max_handoff_chars" in record) target.maxHandoffChars = requireInteger(record["max_handoff_chars"], "max_handoff_chars");
	if ("output_mode" in record) target.outputMode = requireOutputMode(record["output_mode"], "output_mode");
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

function userConfigPath(): string {
	return userAgentConfigPath("subagent.jsonc", USER_CONFIG_ENV);
}

function projectConfigPath(cwd: string): string | undefined {
	return projectAgentConfigPath(cwd, "subagent.jsonc", PROJECT_CONFIG_ENV, PROJECT_ROOT_ENV);
}

async function readOptionalConfig(filePath: string): Promise<{ value: unknown } | undefined> {
	const value = await readOptionalJsoncConfig({
		path: filePath,
		label: "subagent",
		createError: (message, details) => new SubagentConfigError(message, details),
	});
	return value === undefined ? undefined : { value };
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
	const clonedOverrides: Record<string, AgentOverride> = {};
	for (const [name, override] of Object.entries(config.agentOverrides)) {
		clonedOverrides[name] = {
			...(override.model !== undefined ? { model: override.model } : {}),
			...(override.tools !== undefined ? { tools: [...override.tools] } : {}),
		};
	}
	return {
		...config,
		defaultTools: [...config.defaultTools],
		agentOverrides: clonedOverrides,
	};
}

function requireToolList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new SubagentConfigError(`${field} must be a non-empty string array.`);
	}
	return value.map((item) => item.trim());
}

function requireOutputMode(value: unknown, field: string): OutputMode {
	if (value === "inline" || value === "file") return value;
	throw new SubagentConfigError(`${field} must be inline or file.`);
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
