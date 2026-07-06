import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { TuiConfig } from "./types.js";

const CONFIG_PATH_ENV = "PI_TUI_CONFIG";

const defaultConfig: TuiConfig = {
	version: 1,
	enabled: true,
	preset: "compact",
	icons: "unicode",
	chrome: {
		title: true,
		header: false,
		footer: true,
		working_indicator: "dot",
	},
	footer: {
		max_lines: 2,
		segments: ["cwd", "git", "model", "ctx", "tokens", "cost", "status"],
		narrow_segments: ["cwd", "git", "model", "ctx", "tokens", "cost", "status"],
		style: {
			workspace_color: "accent",
			git_color: "success",
			git_icon: "⑂",
		},
	},
	tools: {
		expanded_default: false,
		show_timing: true,
		show_provider: false,
		max_target_chars: 72,
		max_summary_chars: 96,
		collapsed_lines: 2,
	},
	banner: {
		enabled: true,
		style: "ascii",
		layout: "auto",
		side_by_side_min_width: 96,
		tiny_width: 44,
		show_hints: true,
		show_capabilities: true,
		clear_on_first_turn: true,
	},
};

let compiledValidator: ValidateFunction | undefined;

export class TuiConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "TuiConfigError";
	}
}

/** 读取 o-pi TUI JSONC 配置；配置错误直接抛出，避免静默丢失 UI 行为。 */
export async function loadTuiConfig(): Promise<TuiConfig> {
	const configPath = resolveConfigPath();
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return defaultTuiConfig();
		throw new TuiConfigError("tui config cannot be read.", { path: configPath });
	}

	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		throw new TuiConfigError("tui config is not valid JSONC.", {
			path: configPath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}

	const validator = await loadValidator();
	if (!validator(parsed)) {
		throw new TuiConfigError("tui config does not match schema.", { path: configPath, errors: validator.errors ?? [] });
	}
	return mergeConfig(parsed as RawTuiConfig);
}

export function defaultTuiConfig(): TuiConfig {
	return {
		version: 1,
		enabled: defaultConfig.enabled,
		preset: defaultConfig.preset,
		icons: defaultConfig.icons,
		chrome: { ...defaultConfig.chrome },
		footer: {
			max_lines: 2,
			segments: [...defaultConfig.footer.segments],
			narrow_segments: [...defaultConfig.footer.narrow_segments],
			style: { ...defaultConfig.footer.style },
		},
		tools: { ...defaultConfig.tools },
		banner: { ...defaultConfig.banner },
	};
}

interface RawTuiConfig {
	version: 1;
	enabled?: boolean;
	preset?: TuiConfig["preset"];
	icons?: TuiConfig["icons"];
	chrome?: Partial<TuiConfig["chrome"]>;
	footer?: Partial<Omit<TuiConfig["footer"], "style">> & { style?: Partial<TuiConfig["footer"]["style"]> };
	tools?: Partial<TuiConfig["tools"]>;
	banner?: Partial<TuiConfig["banner"]>;
}

function mergeConfig(raw: RawTuiConfig): TuiConfig {
	const merged: TuiConfig = {
		version: 1,
		enabled: raw.enabled ?? defaultConfig.enabled,
		preset: raw.preset ?? defaultConfig.preset,
		icons: raw.icons ?? defaultConfig.icons,
		chrome: {
			title: raw.chrome?.title ?? defaultConfig.chrome.title,
			header: raw.chrome?.header ?? defaultConfig.chrome.header,
			footer: raw.chrome?.footer ?? defaultConfig.chrome.footer,
			working_indicator: raw.chrome?.working_indicator ?? defaultConfig.chrome.working_indicator,
		},
		footer: {
			max_lines: 2,
			segments: [...(raw.footer?.segments ?? defaultConfig.footer.segments)],
			narrow_segments: [...(raw.footer?.narrow_segments ?? defaultConfig.footer.narrow_segments)],
			style: {
				workspace_color: raw.footer?.style?.workspace_color ?? defaultConfig.footer.style.workspace_color,
				git_color: raw.footer?.style?.git_color ?? defaultConfig.footer.style.git_color,
				git_icon: raw.footer?.style?.git_icon ?? defaultConfig.footer.style.git_icon,
			},
		},
		tools: {
			expanded_default: raw.tools?.expanded_default ?? defaultConfig.tools.expanded_default,
			show_timing: raw.tools?.show_timing ?? defaultConfig.tools.show_timing,
			show_provider: raw.tools?.show_provider ?? defaultConfig.tools.show_provider,
			max_target_chars: raw.tools?.max_target_chars ?? defaultConfig.tools.max_target_chars,
			max_summary_chars: raw.tools?.max_summary_chars ?? defaultConfig.tools.max_summary_chars,
			collapsed_lines: raw.tools?.collapsed_lines ?? defaultConfig.tools.collapsed_lines,
		},
		banner: {
			enabled: raw.banner?.enabled ?? defaultConfig.banner.enabled,
			style: raw.banner?.style ?? defaultConfig.banner.style,
			layout: raw.banner?.layout ?? defaultConfig.banner.layout,
			side_by_side_min_width: raw.banner?.side_by_side_min_width ?? defaultConfig.banner.side_by_side_min_width,
			tiny_width: raw.banner?.tiny_width ?? defaultConfig.banner.tiny_width,
			show_hints: raw.banner?.show_hints ?? defaultConfig.banner.show_hints,
			show_capabilities: raw.banner?.show_capabilities ?? defaultConfig.banner.show_capabilities,
			clear_on_first_turn: raw.banner?.clear_on_first_turn ?? defaultConfig.banner.clear_on_first_turn,
		},
	};
	if (merged.tools.collapsed_lines !== 2) throw new TuiConfigError("tools.collapsed_lines only supports 2.");
	return merged;
}

async function loadValidator(): Promise<ValidateFunction> {
	if (compiledValidator !== undefined) return compiledValidator;
	const schemaPath = path.join(projectRoot(), "agent", "schemas", "tui.schema.json");
	let schema: object;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
	} catch {
		throw new TuiConfigError("tui schema cannot be read.", { path: schemaPath });
	}
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
	compiledValidator = ajv.compile(schema);
	return compiledValidator;
}

function resolveConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? path.join(projectRoot(), "agent", "configs", "tui.jsonc");
}

function projectRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
