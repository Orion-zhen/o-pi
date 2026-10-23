import { CONFIG_DEFINITIONS, ConfigError, loadValidatedMergedConfig } from "../config-loader.ts";
import type { BashToolConfig } from "./types.ts";

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
