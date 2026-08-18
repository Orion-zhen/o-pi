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
	preset?: TuiConfig["preset"];
	icons?: TuiConfig["icons"];
	chrome?: Partial<TuiConfig["chrome"]>;
	footer?: Partial<Omit<TuiConfig["footer"], "style">> & { style?: Partial<TuiConfig["footer"]["style"]> };
	tools?: Partial<TuiConfig["tools"]>;
	home?: Partial<TuiConfig["home"]>;
	math?: Partial<TuiConfig["math"]>;
}

interface CompleteTuiConfig extends Required<RawTuiConfig> {
	chrome: TuiConfig["chrome"];
	footer: TuiConfig["footer"];
	tools: TuiConfig["tools"];
	home: TuiConfig["home"];
	math: TuiConfig["math"];
}

function materializeConfig(raw: CompleteTuiConfig): TuiConfig {
	const config: TuiConfig = {
		enabled: raw.enabled,
		preset: raw.preset,
		icons: raw.icons,
		chrome: { ...raw.chrome },
		footer: {
			max_lines: raw.footer.max_lines,
			segments: [...raw.footer.segments],
			narrow_segments: [...raw.footer.narrow_segments],
			style: { ...raw.footer.style },
		},
		tools: { ...raw.tools },
		home: { ...raw.home },
		math: { ...raw.math },
	};
	if (config.tools.collapsed_lines !== 2) throw new TuiConfigError("tools.collapsed_lines only supports 2.");
	return config;
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
