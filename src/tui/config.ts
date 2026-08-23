import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadValidatedMergedConfig,
	readDefaultJsoncConfigSync,
} from "../config-loader.js";
import type { TuiConfig } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("tui.schema.json");

export class TuiConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "TuiConfigError";
	}
}

/** 读取 o-pi TUI JSONC 配置；配置错误直接抛出，避免静默丢失 UI 行为。 */
export async function loadTuiConfig(): Promise<TuiConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.tui, process.cwd(), createError, { partial: loadValidator, complete: loadCompleteValidator },
	);
	return materializeConfig(loaded.merged as CompleteTuiConfig);
}

export function defaultTuiConfig(): TuiConfig {
	return materializeConfig(readDefaultConfig());
}

interface RawTuiConfig {
	enabled?: boolean;
	icons?: TuiConfig["icons"];
	chrome?: Partial<TuiConfig["chrome"]>;
	footer?: Partial<Omit<TuiConfig["footer"], "style">> & { style?: Partial<TuiConfig["footer"]["style"]> };
	home?: Partial<TuiConfig["home"]>;
	math?: Partial<TuiConfig["math"]>;
}

interface CompleteTuiConfig extends Required<RawTuiConfig> {
	chrome: TuiConfig["chrome"];
	footer: TuiConfig["footer"];
	home: TuiConfig["home"];
	math: TuiConfig["math"];
}

function materializeConfig(raw: CompleteTuiConfig): TuiConfig {
	return {
		enabled: raw.enabled,
		icons: raw.icons,
		chrome: { ...raw.chrome },
		footer: {
			segments: [...raw.footer.segments],
			narrow_segments: [...raw.footer.narrow_segments],
			style: { ...raw.footer.style },
		},
		home: { ...raw.home },
		math: { ...raw.math },
	};
}

function readDefaultConfig(): CompleteTuiConfig {
	return readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("tui.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "tui",
		createError,
	}) as CompleteTuiConfig;
}

function createError(message: string, details?: Record<string, unknown>): TuiConfigError {
	return new TuiConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "tui", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "tui", createError });
