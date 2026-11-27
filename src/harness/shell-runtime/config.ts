import { CONFIG_DEFINITIONS, ConfigError, loadValidatedMergedConfig } from "../config-loader.ts";

export interface ShellLimits {
	success_output_bytes: number;
	failure_output_bytes: number;
	live_output_bytes: number;
	max_capture_bytes: number;
}

interface ShellConfig<Pattern> {
	default_timeout_seconds: number;
	python_venv_paths: string[];
	environment: {
		inherit: boolean;
		remove_name_regex: Pattern[];
		expose_pi_session_file: boolean;
	};
	limits: ShellLimits;
}

export type ShellToolsConfig = ShellConfig<RegExp>;

/** 加载配置时编译环境变量过滤规则。 */
export async function loadShellToolsConfig(): Promise<ShellToolsConfig> {
	const loaded = await loadValidatedMergedConfig<ShellConfig<string> & { $schema?: string }>(CONFIG_DEFINITIONS.shellTools, process.cwd());
	const { $schema: _schema, environment, ...config } = loaded.merged;
	const flags = process.platform === "win32" ? "iu" : "u";
	const deniedNames = environment.remove_name_regex.map((rule) => {
		try {
			return new RegExp(rule, flags);
		} catch (error) {
			throw new ConfigError("shell environment remove_name_regex is invalid.", { regex: rule, error: String(error) });
		}
	});
	return { ...config, environment: { ...environment, remove_name_regex: deniedNames } };
}
