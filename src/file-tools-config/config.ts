import { stat } from "node:fs/promises";

import { agentSchemaPath, createSchemaValidator, projectAgentConfigPath, readOptionalJsoncConfigWithSchema, userAgentConfigPath } from "../config-loader.js";
import type { FilesystemPolicy } from "../filesystem/contracts/policy.js";
import type { BuiltinIgnoreProfile, IgnoreConfig } from "../filesystem/contracts/visibility.js";
import { createVisibilityPolicy } from "../filesystem/services/visibility/policy.js";
import { defaultFileToolLimits, type FileToolLimits } from "../file-tool-limits.js";

const USER_CONFIG_ENV = "PI_FILE_TOOLS_CONFIG";
const PROJECT_CONFIG_ENV = "PI_FILE_TOOLS_PROJECT_CONFIG";
const PROJECT_ROOT_ENV = "PI_FILE_TOOLS_PROJECT_ROOT";

export interface FileToolsConfig {
	filesystem: FilesystemPolicy;
	limits: FileToolLimits;
}

interface RawFileToolsConfig {
	blocked_path?: string[];
	ignored_path?: string[];
	limits?: Partial<FileToolLimits>;
	ignore?: {
		piignore?: boolean;
		gitignore?: boolean;
		git_tracked_files_bypass?: boolean;
		builtin_profile?: BuiltinIgnoreProfile;
	};
}

interface ConfigCacheEntry {
	fingerprint: string;
	result: FileToolsConfigResult;
}

export interface FileToolsConfigFailure {
	readonly ok: false;
	readonly error: { readonly message: string; readonly details?: Record<string, unknown> };
}

export type FileToolsConfigResult =
	| { readonly ok: true; readonly value: FileToolsConfig }
	| FileToolsConfigFailure;

export interface FileToolsConfigLoader {
	load(cwd: string): Promise<FileToolsConfigResult>;
}

class FileToolsConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "FileToolsConfigError";
	}
}

/** Owns config metadata caches for one file-tools runtime. */
export class FileToolsConfigProvider implements FileToolsConfigLoader {
	private readonly cache = new Map<string, ConfigCacheEntry>();
	private readonly pending = new Map<string, Promise<ConfigCacheEntry>>();
	private epoch = 0;
	private disposed = false;

	/** Load user and invocation-cwd project JSONC before workspace data-plane access. */
	async load(cwd: string): Promise<FileToolsConfigResult> {
		if (this.disposed) return configFailure("File-tools config provider is shut down.");
		const userPath = userConfigPath();
		const projectPath = projectConfigPath(cwd);
		const paths = projectPath === undefined ? [userPath] : [userPath, projectPath];
		const cacheKey = paths.join("\0");
		const fingerprint = await configFingerprint(paths);
		const cached = this.cache.get(cacheKey);
		if (cached?.fingerprint === fingerprint) return structuredClone(cached.result);

		const pendingKey = `${cacheKey}\0${fingerprint}`;
		const epoch = this.epoch;
		let pending = this.pending.get(pendingKey);
		if (pending === undefined) {
			pending = loadStableConfig(userPath, projectPath, paths, fingerprint);
			this.pending.set(pendingKey, pending);
		}
		try {
			const loaded = await pending;
			if (this.disposed) return configFailure("File-tools config provider is shut down.");
			if (this.epoch === epoch) this.cache.set(cacheKey, loaded);
			return structuredClone(loaded.result);
		} finally {
			if (this.pending.get(pendingKey) === pending) this.pending.delete(pendingKey);
		}
	}

	private clear(): void {
		this.epoch += 1;
		this.cache.clear();
		this.pending.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear();
	}
}

export async function loadFileToolsConfig(cwd: string): Promise<FileToolsConfigResult> {
	const provider = new FileToolsConfigProvider();
	try {
		return await provider.load(cwd);
	} finally {
		provider.dispose();
	}
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
		if (current === fingerprint || attempt === 1) {
			return { fingerprint: current, result: result.ok ? configSuccess(bindConfigFingerprint(result.value, current)) : result };
		}
		fingerprint = current;
	}
	throw new Error("unreachable config load state");
}

async function loadMergedConfig(userPath: string, projectPath: string | undefined): Promise<FileToolsConfigResult> {
	const userRaw = await readConfig(userPath);
	if (isConfigReadFailure(userRaw)) return userRaw;
	const userConfig = mergeConfig(defaultFileToolsConfig(), userRaw);

	const projectRaw = projectPath === undefined ? undefined : await readConfig(projectPath);
	if (projectRaw !== undefined && isConfigReadFailure(projectRaw)) return projectRaw;
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

async function readConfig(configPath: string): Promise<RawFileToolsConfig | undefined | FileToolsConfigFailure> {
	try {
		const parsed = await readOptionalJsoncConfigWithSchema({
			path: configPath,
			label: "file-tools",
			loadValidator,
			createError: (message, details) => new FileToolsConfigError(message, details),
		});
		return parsed as RawFileToolsConfig | undefined;
	} catch (error) {
		if (error instanceof FileToolsConfigError) return configFailure(error.message, error.details);
		throw error;
	}
}

export function defaultFileToolsConfig(): FileToolsConfig {
	const visibility = createVisibilityPolicy();
	const filesystem: FilesystemPolicy = {
		blockedPaths: [".git/"],
		visibility,
		fingerprint: `defaults\0${JSON.stringify({ blockedPaths: [".git/"], visibility: visibility.fingerprint })}`,
	};
	return { filesystem, limits: defaultFileToolLimits() };
}

function mergeProjectConfig(
	userConfig: FileToolsConfig,
	raw: RawFileToolsConfig | undefined,
	sourcePath: string | undefined,
): FileToolsConfigResult {
	if (raw === undefined) return configSuccess(userConfig);
	const unsupportedIgnoreKeys = ["piignore", "gitignore", "git_tracked_files_bypass"].filter((key) => key in (raw.ignore ?? {}));
	if (unsupportedIgnoreKeys.length > 0) {
		return configFailure("project file-tools config cannot change user ignore safety switches.", {
			path: sourcePath,
			fields: unsupportedIgnoreKeys.map((key) => `ignore.${key}`),
		});
	}
	const merged = mergeConfig(userConfig, raw);
	return configSuccess(withPolicies(merged, {
		blockedPaths: appendUnique(userConfig.filesystem.blockedPaths, raw.blocked_path),
		ignoredPaths: appendUnique(userConfig.filesystem.visibility.ignoredPaths, raw.ignored_path),
	}));
}

function mergeConfig(base: FileToolsConfig, raw: RawFileToolsConfig | undefined): FileToolsConfig {
	const ignoredPaths = raw?.ignored_path ?? [...base.filesystem.visibility.ignoredPaths];
	const visibility = createVisibilityPolicy({
		ignoredPaths,
		ignore: mergeIgnoreConfig(base.filesystem.visibility.ignore, raw?.ignore),
	});
	const blockedPaths = raw?.blocked_path ?? [...base.filesystem.blockedPaths];
	return {
		filesystem: {
			blockedPaths,
			visibility,
			fingerprint: `pending\0${JSON.stringify({ blockedPaths, visibility: visibility.fingerprint })}`,
		},
		limits: { ...base.limits, ...raw?.limits },
	};
}

function withPolicies(
	config: FileToolsConfig,
	overrides: { readonly blockedPaths: readonly string[]; readonly ignoredPaths: readonly string[] },
): FileToolsConfig {
	const visibility = createVisibilityPolicy({ ignoredPaths: overrides.ignoredPaths, ignore: config.filesystem.visibility.ignore });
	return {
		...config,
		filesystem: {
			blockedPaths: [...overrides.blockedPaths],
			visibility,
			fingerprint: `pending\0${JSON.stringify({ blockedPaths: overrides.blockedPaths, visibility: visibility.fingerprint })}`,
		},
	};
}

function bindConfigFingerprint(config: FileToolsConfig, sourceFingerprint: string): FileToolsConfig {
	const visibility = createVisibilityPolicy({
		ignoredPaths: config.filesystem.visibility.ignoredPaths,
		ignore: config.filesystem.visibility.ignore,
		configFingerprint: sourceFingerprint,
	});
	return {
		...config,
		filesystem: {
			blockedPaths: [...config.filesystem.blockedPaths],
			visibility,
			fingerprint: `${sourceFingerprint}\0${JSON.stringify({ blockedPaths: config.filesystem.blockedPaths, visibility: visibility.fingerprint })}`,
		},
	};
}

function mergeIgnoreConfig(base: IgnoreConfig, raw: RawFileToolsConfig["ignore"]): IgnoreConfig {
	return {
		...structuredClone(base),
		piignore: { ...base.piignore, enabled: raw?.piignore ?? base.piignore.enabled },
		gitignore: {
			...base.gitignore,
			enabled: raw?.gitignore ?? base.gitignore.enabled,
			trackedFilesBypass: raw?.git_tracked_files_bypass ?? base.gitignore.trackedFilesBypass,
		},
		builtinProfile: raw?.builtin_profile ?? base.builtinProfile,
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

function configSuccess(value: FileToolsConfig): FileToolsConfigResult {
	return { ok: true, value };
}

function configFailure(message: string, details?: Record<string, unknown>): FileToolsConfigFailure {
	return { ok: false, error: { message, ...(details === undefined ? {} : { details }) } };
}

function isConfigReadFailure(
	value: RawFileToolsConfig | undefined | FileToolsConfigFailure,
): value is FileToolsConfigFailure {
	return value !== undefined && "ok" in value && !value.ok;
}

function appendUnique(base: readonly string[], extra: readonly string[] | undefined): string[] {
	if (extra === undefined) return [...base];
	return Array.from(new Set([...base, ...extra]));
}
