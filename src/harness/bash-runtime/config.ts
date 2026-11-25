import { CONFIG_DEFINITIONS, ConfigError, loadValidatedMergedConfig } from "../config-loader.ts";

export interface BashEnvironmentConfig {
	inherit: boolean;
	remove_name_regex: string[];
	expose_pi_session_file: boolean;
}

export interface BashLimits {
	success_output_bytes: number;
	failure_output_bytes: number;
	live_output_bytes: number;
	max_capture_bytes: number;
}

export interface BashToolConfig {
	default_timeout_seconds: number;
	python_venv_paths: string[];
	environment: BashEnvironmentConfig;
	limits: BashLimits;
}

/** 配置错误直接失败，环境过滤规则在使用前编译校验。 */
export async function loadBashToolConfig(): Promise<BashToolConfig> {
	const loaded = await loadValidatedMergedConfig<BashToolConfig & { $schema?: string }>(CONFIG_DEFINITIONS.bashTool, process.cwd());
	const { $schema: _schema, ...config } = loaded.merged;
	for (const rule of config.environment.remove_name_regex) {
		try {
			new RegExp(rule, process.platform === "win32" ? "iu" : "u");
		} catch (error) {
			throw new ConfigError("bash environment remove_name_regex is invalid.", { regex: rule, error: String(error) });
		}
	}
	return config;
}
