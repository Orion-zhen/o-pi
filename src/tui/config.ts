import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	loadValidatedMergedConfig,
} from "../config-loader.js";
import type { TuiConfig } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("tui.schema.json");
type TuiConfigFile = TuiConfig & { $schema?: string };

class TuiConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "TuiConfigError";
	}
}

/** 配置加载器负责校验、合并和复制，这里只剔除文件元数据。 */
export async function loadTuiConfig(): Promise<TuiConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.tui, process.cwd(), createError, { partial: loadValidator, complete: loadCompleteValidator },
	);
	const { $schema: _schema, ...config } = loaded.merged as TuiConfigFile;
	return config;
}

function createError(message: string, details?: Record<string, unknown>): TuiConfigError {
	return new TuiConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "tui", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "tui", createError });
