import { CONFIG_DEFINITIONS, loadValidatedConfigLayers } from "../config-loader.ts";
import type { AgentOverride, SubagentConfig } from "./types.ts";

interface RawSubagentConfig {
	default_model: string | null;
	max_parallel_tasks: number;
	max_concurrency: number;
	timeout_ms: number;
	retries: number;
	retry_delay_ms: number;
	retry_on_empty_output: boolean;
	retry_on_timeout: boolean;
	max_inline_output_tokens: number;
	max_handoff_tokens: number;
	allow_project_agents: boolean;
	project_agents_override_user: boolean;
	confirm_write_agents: boolean;
	default_tools: string[];
	agent_overrides: Record<string, AgentOverride>;
}

/** 先校验各层权限并整体覆盖字段，最后只转换一次运行时配置。 */
export async function loadSubagentConfig(cwd = process.cwd()): Promise<SubagentConfig> {
	const { layers } = await loadValidatedConfigLayers(CONFIG_DEFINITIONS.subagent, cwd);
	const [defaults, ...overlays] = layers;
	const raw = defaults.value as RawSubagentConfig;
	// agent_overrides 和数组沿用高层整体替换，不递归合并。
	for (const layer of overlays) Object.assign(raw, layer.value);
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
		defaultTools: raw.default_tools,
		agentOverrides: Object.fromEntries(Object.entries(raw.agent_overrides).map(([name, override]) => [name, {
			...override,
			...(override.model === undefined ? {} : { model: override.model.trim() }),
		}])),
	};
}
