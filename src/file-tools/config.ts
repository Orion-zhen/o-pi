import { stat } from "node:fs/promises";
import { agentSchemaPath, createSchemaValidator, projectAgentConfigPath, readOptionalJsoncConfigWithSchema, userAgentConfigPath } from "../config-loader.js";
import { pathMatchesAnyRule, type PathIdentity } from "../safety/path-guard.js";
import { fail, isFailed } from "./core/errors.js";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_LINES } from "./core/text-file.js";
import type { FailedResult, ToolOutcome } from "./types.js";
import type { PartialIgnoreConfig } from "./ignore/ignore-types.js";

const DEFAULT_MAX_LS_ENTRIES = 200;
const DEFAULT_GREP_OUTPUT_TOKEN_BUDGET = 1_600;
const DEFAULT_GREP_RESULT_LIMIT = 8;
const DEFAULT_GREP_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_GREP_MAX_FILES_SCANNED = 100_000;
const USER_CONFIG_ENV = "PI_FILE_TOOLS_CONFIG";
const PROJECT_CONFIG_ENV = "PI_FILE_TOOLS_PROJECT_CONFIG";
const PROJECT_ROOT_ENV = "PI_FILE_TOOLS_PROJECT_ROOT";

export interface FileToolsConfig {
	blocked_path: string[];
	ignored_path: string[];
	limits: {
		ls_entries: number;
		read_lines: number;
		read_bytes: number;
		find_output_token_budget: number;
		find_result_limit: number;
		find_max_entries_scanned: number;
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

interface ConfigCacheEntry {
	fingerprint: string;
	result: ToolOutcome<FileToolsConfig>;
}

export type ToolPathIdentity = PathIdentity;

const defaultConfig: FileToolsConfig = {
	blocked_path: [".git/"],
	ignored_path: [],
	limits: {
		ls_entries: DEFAULT_MAX_LS_ENTRIES,
		read_lines: DEFAULT_MAX_OUTPUT_LINES,
		read_bytes: DEFAULT_MAX_OUTPUT_BYTES,
		find_output_token_budget: 800,
		find_result_limit: 50,
		find_max_entries_scanned: 100_000,
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

const configCache = new Map<string, ConfigCacheEntry>();
const pendingConfigs = new Map<string, Promise<ConfigCacheEntry>>();

class FileToolsConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "FileToolsConfigError";
	}
}

/** 读取用户与项目文件工具 JSONC 配置；项目配置只能追加路径规则并覆盖普通预算。 */
export async function loadFileToolsConfig(cwd = process.cwd()): Promise<ToolOutcome<FileToolsConfig>> {
	const userPath = userConfigPath();
	const projectPath = projectConfigPath(cwd);
	const paths = projectPath === undefined ? [userPath] : [userPath, projectPath];
	const cacheKey = paths.join("\0");
	const fingerprint = await configFingerprint(paths);
	const cached = configCache.get(cacheKey);
	if (cached?.fingerprint === fingerprint) return structuredClone(cached.result);

	const pendingKey = `${cacheKey}\0${fingerprint}`;
	let pending = pendingConfigs.get(pendingKey);
	if (pending === undefined) {
		pending = loadStableConfig(userPath, projectPath, paths, fingerprint);
		pendingConfigs.set(pendingKey, pending);
	}
	try {
		const loaded = await pending;
		configCache.set(cacheKey, loaded);
		return structuredClone(loaded.result);
	} finally {
		if (pendingConfigs.get(pendingKey) === pending) pendingConfigs.delete(pendingKey);
	}
}

export function clearFileToolsConfigCacheForTests(): void {
	configCache.clear();
	pendingConfigs.clear();
}

async function loadStableConfig(
	userPath: string,
	projectPath: string | undefined,
	paths: string[],
	initialFingerprint: string,
): Promise<ConfigCacheEntry> {
	let fingerprint = initialFingerprint;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await loadMergedConfig(userPath, projectPath);
		const current = await configFingerprint(paths);
		if (current === fingerprint || attempt === 1) return { fingerprint: current, result };
		fingerprint = current;
	}
	throw new Error("unreachable config load state");
}

async function loadMergedConfig(userPath: string, projectPath: string | undefined): Promise<ToolOutcome<FileToolsConfig>> {
	const userRaw = await readConfig(userPath);
	if (isFailed(userRaw)) return userRaw;
	const userConfig = mergeConfig(defaultFileToolsConfig(), userRaw);

	const projectRaw = projectPath === undefined ? undefined : await readConfig(projectPath);
	if (projectRaw !== undefined && isFailed(projectRaw)) return projectRaw;
	return mergeProjectConfig(userConfig, projectRaw, projectPath);
}

async function configFingerprint(paths: string[]): Promise<string> {
	return (await Promise.all(paths.map(fileFingerprint))).join("|");
}

async function fileFingerprint(filePath: string): Promise<string> {
	try {
		const info = await stat(filePath);
		return `${filePath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return `${filePath}:missing`;
		return `${filePath}:unreadable`;
	}
}

async function readConfig(configPath: string): Promise<RawFileToolsConfig | undefined | FailedResult> {
	try {
		const parsed = await readOptionalJsoncConfigWithSchema({
			path: configPath,
			label: "file-tools",
			loadValidator,
			createError: (message, details) => new FileToolsConfigError(message, details),
		});
		return parsed as RawFileToolsConfig | undefined;
	} catch (error) {
		if (error instanceof FileToolsConfigError) {
			return error.details === undefined ? fail("CONFIG_ERROR", error.message) : fail("CONFIG_ERROR", error.message, { details: error.details });
		}
		throw error;
	}
}

export function ignoreConfigFromFileTools(config: FileToolsConfig): PartialIgnoreConfig {
	return {
		piignore: { enabled: config.ignore.piignore },
		gitignore: { enabled: config.ignore.gitignore, trackedFilesBypass: config.ignore.git_tracked_files_bypass },
		builtinProfile: config.ignore.builtin_profile,
	};
}

export function isBlockedPath(config: FileToolsConfig, identity: ToolPathIdentity): boolean {
	return pathMatchesAnyRule(identity, config.blocked_path);
}

export function isIgnoredPath(config: FileToolsConfig, identity: ToolPathIdentity): boolean {
	return pathMatchesAnyRule(identity, config.ignored_path);
}

export function toolPathIdentity(displayPath: string, absolutePath: string, workspacePath: string | undefined): ToolPathIdentity {
	return {
		displayPath,
		absolutePath,
		...(workspacePath !== undefined ? { workspacePath } : {}),
	};
}

export function defaultFileToolsConfig(): FileToolsConfig {
	return structuredClone(defaultConfig);
}

function mergeProjectConfig(userConfig: FileToolsConfig, raw: RawFileToolsConfig | undefined, sourcePath: string | undefined): ToolOutcome<FileToolsConfig> {
	if (raw === undefined) return userConfig;
	const unsupportedIgnoreKeys = ["piignore", "gitignore", "git_tracked_files_bypass"].filter((key) => key in (raw.ignore ?? {}));
	if (unsupportedIgnoreKeys.length > 0) {
		return fail("CONFIG_ERROR", "project file-tools config cannot change user ignore safety switches.", {
			details: { path: sourcePath, fields: unsupportedIgnoreKeys.map((key) => `ignore.${key}`) },
		});
	}
	const merged = mergeConfig(userConfig, raw);
	return {
		...merged,
		blocked_path: appendUnique(userConfig.blocked_path, raw.blocked_path),
		ignored_path: appendUnique(userConfig.ignored_path, raw.ignored_path),
	};
}

function mergeConfig(base: FileToolsConfig, raw: RawFileToolsConfig | undefined): FileToolsConfig {
	return {
		blocked_path: raw?.blocked_path ?? [...base.blocked_path],
		ignored_path: raw?.ignored_path ?? [...base.ignored_path],
		limits: { ...base.limits, ...raw?.limits },
		ignore: { ...base.ignore, ...raw?.ignore },
	};
}

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("file-tools.schema.json"),
	label: "file-tools",
	createError: (message, details) => new FileToolsConfigError(message, details),
});

function userConfigPath(): string {
	return userAgentConfigPath("file-tools.jsonc", USER_CONFIG_ENV);
}

function projectConfigPath(cwd: string): string | undefined {
	return projectAgentConfigPath(cwd, "file-tools.jsonc", PROJECT_CONFIG_ENV, PROJECT_ROOT_ENV);
}

function appendUnique(base: string[], extra: string[] | undefined): string[] {
	if (extra === undefined) return [...base];
	return Array.from(new Set([...base, ...extra]));
}
