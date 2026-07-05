import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { fail } from "./errors.js";
import type { FailedResult, ToolOutcome } from "./types.js";
import type { PartialIgnoreConfig } from "./ignore/ignore-types.js";

const DEFAULT_MAX_LS_ENTRIES = 200;
const DEFAULT_MAX_READ_LINES = 2_000;
const DEFAULT_MAX_READ_BYTES = 50 * 1024;
const DEFAULT_GREP_OUTPUT_TOKEN_BUDGET = 1_600;
const DEFAULT_GREP_RESULT_LIMIT = 8;
const DEFAULT_GREP_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_GREP_MAX_FILES_SCANNED = 100_000;
const CONFIG_PATH_ENV = "PI_FILE_TOOLS_CONFIG";

export interface FileToolsConfig {
	blocked_path: string[];
	ignored_path: string[];
	limits: {
		ls_entries: number;
		read_lines: number;
		read_bytes: number;
		find_output_token_budget: number;
		find_flat_result_limit: number;
		find_grouped_result_limit: number;
		find_max_matches_scanned: number;
		find_max_exact_paths: number;
		grep_output_token_budget: number;
		grep_result_limit: number;
		grep_max_file_bytes: number;
		grep_max_files_scanned: number;
	};
	ignore: {
		piignore: boolean;
		gitignore: boolean;
		git_tracked_files_bypass: boolean;
		builtin_profile: "none" | "minimal" | "performance";
	};
}

interface RawFileToolsConfig {
	blocked_path?: string[];
	ignored_path?: string[];
	limits?: Partial<FileToolsConfig["limits"]>;
	ignore?: Partial<FileToolsConfig["ignore"]>;
}

export interface ToolPathIdentity {
	displayPath: string;
	absolutePath: string;
	workspacePath?: string;
}

const defaultConfig: FileToolsConfig = {
	blocked_path: [".git/"],
	ignored_path: [],
	limits: {
		ls_entries: DEFAULT_MAX_LS_ENTRIES,
		read_lines: DEFAULT_MAX_READ_LINES,
		read_bytes: DEFAULT_MAX_READ_BYTES,
		find_output_token_budget: 800,
		find_flat_result_limit: 5,
		find_grouped_result_limit: 40,
		find_max_matches_scanned: 100_000,
		find_max_exact_paths: 200,
		grep_output_token_budget: DEFAULT_GREP_OUTPUT_TOKEN_BUDGET,
		grep_result_limit: DEFAULT_GREP_RESULT_LIMIT,
		grep_max_file_bytes: DEFAULT_GREP_MAX_FILE_BYTES,
		grep_max_files_scanned: DEFAULT_GREP_MAX_FILES_SCANNED,
	},
	ignore: {
		piignore: true,
		gitignore: true,
		git_tracked_files_bypass: true,
		builtin_profile: "minimal",
	},
};

let compiledValidator: ValidateFunction | undefined;

/** 读取文件工具 JSONC 配置；配置错误时 fail closed，避免误放开 blocked_path。 */
export async function loadFileToolsConfig(): Promise<ToolOutcome<FileToolsConfig>> {
	const configPath = resolveConfigPath();
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return defaultConfig;
		return fail("CONFIG_ERROR", "file-tools config cannot be read.", { details: { path: configPath } });
	}

	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		if (first === undefined) return fail("CONFIG_ERROR", "file-tools config is not valid JSONC.", { details: { path: configPath } });
		return fail("CONFIG_ERROR", "file-tools config is not valid JSONC.", {
			details: { path: configPath, error: printParseErrorCode(first.error), offset: first.offset },
		});
	}

	const validator = await loadValidator();
	if (isFailed(validator)) return validator;
	if (!validator(parsed)) {
		return fail("CONFIG_ERROR", "file-tools config does not match schema.", {
			details: { path: configPath, errors: validator.errors ?? [] },
		});
	}

	return mergeConfig(parsed as RawFileToolsConfig);
}

export function ignoreConfigFromFileTools(config: FileToolsConfig): PartialIgnoreConfig {
	return {
		piignore: { enabled: config.ignore.piignore },
		gitignore: { enabled: config.ignore.gitignore, trackedFilesBypass: config.ignore.git_tracked_files_bypass },
		builtinProfile: config.ignore.builtin_profile,
	};
}

export function isBlockedPath(config: FileToolsConfig, identity: ToolPathIdentity): boolean {
	return config.blocked_path.some((rule) => pathMatchesRule(identity, rule));
}

export function isIgnoredPath(config: FileToolsConfig, identity: ToolPathIdentity): boolean {
	return config.ignored_path.some((rule) => pathMatchesRule(identity, rule));
}

export function toolPathIdentity(displayPath: string, absolutePath: string, workspacePath: string | undefined): ToolPathIdentity {
	return {
		displayPath,
		absolutePath,
		...(workspacePath !== undefined ? { workspacePath } : {}),
	};
}

export function defaultFileToolsConfig(): FileToolsConfig {
	return {
		blocked_path: [...defaultConfig.blocked_path],
		ignored_path: [...defaultConfig.ignored_path],
		limits: { ...defaultConfig.limits },
		ignore: { ...defaultConfig.ignore },
	};
}

function mergeConfig(raw: RawFileToolsConfig): FileToolsConfig {
	return {
		blocked_path: raw.blocked_path ?? [...defaultConfig.blocked_path],
		ignored_path: raw.ignored_path ?? [...defaultConfig.ignored_path],
		limits: {
			ls_entries: raw.limits?.ls_entries ?? defaultConfig.limits.ls_entries,
			read_lines: raw.limits?.read_lines ?? defaultConfig.limits.read_lines,
			read_bytes: raw.limits?.read_bytes ?? defaultConfig.limits.read_bytes,
			find_output_token_budget: raw.limits?.find_output_token_budget ?? defaultConfig.limits.find_output_token_budget,
			find_flat_result_limit: raw.limits?.find_flat_result_limit ?? defaultConfig.limits.find_flat_result_limit,
			find_grouped_result_limit: raw.limits?.find_grouped_result_limit ?? defaultConfig.limits.find_grouped_result_limit,
			find_max_matches_scanned: raw.limits?.find_max_matches_scanned ?? defaultConfig.limits.find_max_matches_scanned,
			find_max_exact_paths: raw.limits?.find_max_exact_paths ?? defaultConfig.limits.find_max_exact_paths,
			grep_output_token_budget: raw.limits?.grep_output_token_budget ?? defaultConfig.limits.grep_output_token_budget,
			grep_result_limit: raw.limits?.grep_result_limit ?? defaultConfig.limits.grep_result_limit,
			grep_max_file_bytes: raw.limits?.grep_max_file_bytes ?? defaultConfig.limits.grep_max_file_bytes,
			grep_max_files_scanned: raw.limits?.grep_max_files_scanned ?? defaultConfig.limits.grep_max_files_scanned,
		},
		ignore: {
			piignore: raw.ignore?.piignore ?? defaultConfig.ignore.piignore,
			gitignore: raw.ignore?.gitignore ?? defaultConfig.ignore.gitignore,
			git_tracked_files_bypass: raw.ignore?.git_tracked_files_bypass ?? defaultConfig.ignore.git_tracked_files_bypass,
			builtin_profile: raw.ignore?.builtin_profile ?? defaultConfig.ignore.builtin_profile,
		},
	};
}

async function loadValidator(): Promise<ToolOutcome<ValidateFunction>> {
	if (compiledValidator !== undefined) return compiledValidator;
	const schemaPath = path.join(projectRoot(), "agent", "schemas", "file-tools.schema.json");
	let schema;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
	} catch {
		return fail("CONFIG_ERROR", "file-tools schema cannot be read.", { details: { path: schemaPath } });
	}
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
	let validator: ValidateFunction;
	try {
		validator = ajv.compile(schema);
	} catch (error) {
		return fail("CONFIG_ERROR", "file-tools schema is invalid.", {
			details: { path: schemaPath, error: error instanceof Error ? error.message : String(error) },
		});
	}
	compiledValidator = validator;
	return validator;
}

function resolveConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? path.join(configDirectory(), "file-tools.jsonc");
}

function configDirectory(): string {
	return path.join(projectRoot(), "agent", "configs");
}

function projectRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function pathMatchesRule(identity: ToolPathIdentity, rule: string): boolean {
	const normalizedRule = normalizeRule(rule);
	if (normalizedRule.path.length === 0) return false;
	const candidates = candidatePaths(identity, normalizedRule.absolute);
	return candidates.some((candidate) => matchCandidate(candidate, normalizedRule.path, normalizedRule.directory));
}

function normalizeRule(rule: string): { path: string; absolute: boolean; directory: boolean } {
	const directory = /[\\/]$/.test(rule);
	const absolute = path.isAbsolute(rule);
	const normalized = normalizePath(rule).replace(/\/+$/, "");
	return { path: absolute ? normalized : normalized.replace(/^\/+/, ""), absolute, directory };
}

function candidatePaths(identity: ToolPathIdentity, absoluteRule: boolean): string[] {
	if (absoluteRule) return [normalizePath(identity.absolutePath)];
	const result = [normalizePath(identity.displayPath)];
	if (identity.workspacePath !== undefined) result.push(normalizePath(identity.workspacePath));
	result.push(normalizePath(identity.absolutePath));
	return Array.from(new Set(result));
}

function matchCandidate(candidate: string, rule: string, directory: boolean): boolean {
	if (candidate === rule) return true;
	if (directory && candidate.startsWith(`${rule}/`)) return true;
	if (candidate.endsWith(`/${rule}`)) return true;
	return directory && candidate.includes(`/${rule}/`);
}

function normalizePath(value: string): string {
	return path.normalize(value).replace(/\\/g, "/");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFailed<T>(result: T | FailedResult): result is FailedResult {
	return typeof result === "object" && result !== null && "status" in result && result.status === "failed";
}
