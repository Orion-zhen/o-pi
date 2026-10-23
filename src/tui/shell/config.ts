import { CONFIG_DEFINITIONS, loadValidatedMergedConfig } from "../../harness/config-loader.ts";
import type { TuiConfig } from "./types.ts";

/** 配置加载器负责校验、合并和复制，这里只剔除文件元数据。 */
export async function loadTuiConfig(): Promise<TuiConfig> {
	const loaded = await loadValidatedMergedConfig<TuiConfig & { $schema?: string }>(CONFIG_DEFINITIONS.tui, process.cwd());
	const { $schema: _schema, ...config } = loaded.merged;
	return config;
}
