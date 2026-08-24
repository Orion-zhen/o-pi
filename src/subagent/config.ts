import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	loadConfigLayers,
	validateConfigValue,
} from "../config-loader.js";
import type { SchemaValidateFunction } from "../schema-validator.js";
import type { AgentOverride, SubagentConfig } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("subagent.schema.json");
const PROJECT_SCHEMA_PATH = agentSchemaPath("subagent-project.schema.json");

interface RawCommonConfig {
	max_parallel_tasks?: number;
	max_concurrency?: number;
	timeout_ms?: number;
	retries?: number;
	retry_delay_ms?: number;
	retry_on_empty_output?: boolean;
	retry_on_timeout?: boolean;
	max_inline_output_tokens?: number;
	max_handoff_tokens?: number;
}

interface RawAgentOverride {
	model?: string;
	tools?: string[];
}

interface RawUserConfig extends RawCommonConfig {
	default_model?: string | null;
	allow_project_agents?: boolean;
	project_agents_override_user?: boolean;
	confirm_write_agents?: boolean;
	default_tools?: string[];
	agent_overrides?: Record<string, RawAgentOverride>;
}

interface RawDefaultConfig extends Required<RawCommonConfig> {
	default_model: string | null;
	allow_project_agents: boolean;
	project_agents_override_user: boolean;
	confirm_write_agents: boolean;
	default_tools: string[];
	agent_overrides: Record<string, RawAgentOverride>;
}

export class SubagentConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "SubagentConfigError";
	}
}

/** 加载用户与项目 JSONC 配置；项目配置只能覆盖普通运行参数。 */
export async function loadSubagentConfig(cwd = process.cwd()): Promise<SubagentConfig> {
	const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.subagent, cwd, createError);
	const [defaultLayer, ...overlays] = loaded.layers;
	await validateLayer(defaultLayer, loadCompleteValidator);
	const config = materializeDefaultConfig(defaultLayer.value as RawDefaultConfig);

	for (const layer of overlays) {
		await validateLayer(layer, layer.kind === "project" ? loadProjectValidator : loadValidator);
		const raw = layer.value as RawUserConfig;
		assignCommon(config, raw);
		if (layer.kind === "user") assignUser(config, raw);
	}
	return config;
}

function validateLayer(
	layer: { path: string; kind: "default" | "user" | "project"; value: unknown },
	loadValidator: () => Promise<SchemaValidateFunction>,
): Promise<void> {
	return validateConfigValue({
		path: layer.path,
		label: `subagent ${layer.kind}`,
		value: layer.value,
		layer: layer.kind,
		loadValidator,
		createError,
	});
}

function assignCommon(target: SubagentConfig, raw: RawCommonConfig): void {
	if (raw.max_parallel_tasks !== undefined) target.maxParallelTasks = raw.max_parallel_tasks;
	if (raw.max_concurrency !== undefined) target.maxConcurrency = raw.max_concurrency;
	if (raw.timeout_ms !== undefined) target.timeoutMs = raw.timeout_ms;
	if (raw.retries !== undefined) target.retries = raw.retries;
	if (raw.retry_delay_ms !== undefined) target.retryDelayMs = raw.retry_delay_ms;
	if (raw.retry_on_empty_output !== undefined) target.retryOnEmptyOutput = raw.retry_on_empty_output;
	if (raw.retry_on_timeout !== undefined) target.retryOnTimeout = raw.retry_on_timeout;
	if (raw.max_inline_output_tokens !== undefined) target.maxInlineOutputTokens = raw.max_inline_output_tokens;
	if (raw.max_handoff_tokens !== undefined) target.maxHandoffTokens = raw.max_handoff_tokens;
}

function assignUser(target: SubagentConfig, raw: RawUserConfig): void {
	if (raw.default_model !== undefined) {
		if (raw.default_model === null) delete target.defaultModel;
		else target.defaultModel = raw.default_model.trim();
	}
	if (raw.allow_project_agents !== undefined) target.allowProjectAgents = raw.allow_project_agents;
	if (raw.project_agents_override_user !== undefined) target.projectAgentsOverrideUser = raw.project_agents_override_user;
	if (raw.confirm_write_agents !== undefined) target.confirmWriteAgents = raw.confirm_write_agents;
	if (raw.default_tools !== undefined) target.defaultTools = [...raw.default_tools];
	if (raw.agent_overrides !== undefined) target.agentOverrides = materializeOverrides(raw.agent_overrides);
}

function materializeDefaultConfig(raw: RawDefaultConfig): SubagentConfig {
	return {
		...(raw.default_model === null ? {} : { defaultModel: raw.default_model.trim() }),
		maxParallelTasks: raw.max_parallel_tasks,
		maxConcurrency: raw.max_concurrency,
		timeoutMs: raw.timeout_ms,
		retries: raw.retries,
		retryDelayMs: raw.retry_delay_ms,
		retryOnEmptyOutput: raw.retry_on_empty_output,
		retryOnTimeout: raw.retry_on_timeout,
		maxInlineOutputTokens: raw.max_inline_output_tokens,
		maxHandoffTokens: raw.max_handoff_tokens,
		allowProjectAgents: raw.allow_project_agents,
		projectAgentsOverrideUser: raw.project_agents_override_user,
		confirmWriteAgents: raw.confirm_write_agents,
		defaultTools: [...raw.default_tools],
		agentOverrides: materializeOverrides(raw.agent_overrides),
	};
}

function materializeOverrides(raw: Record<string, RawAgentOverride>): Record<string, AgentOverride> {
	return Object.fromEntries(Object.entries(raw).map(([name, override]) => [name, {
		...(override.model === undefined ? {} : { model: override.model.trim() }),
		...(override.tools === undefined ? {} : { tools: [...override.tools] }),
	}]));
}

function createError(message: string, details?: Record<string, unknown>): SubagentConfigError {
	return new SubagentConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "subagent", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "subagent", createError });
const loadProjectValidator = createSchemaValidator({ schemaPath: PROJECT_SCHEMA_PATH, label: "subagent project", createError });
