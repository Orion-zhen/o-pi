import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	configLayerFingerprint,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadConfigLayers,
	readDefaultJsoncConfigSync,
	resolveConfigLayerPaths,
	validateConfigValue,
} from "../config-loader.js";
import type { FilesystemPolicy } from "../filesystem/contracts/policy.js";
import type { BuiltinIgnoreProfile, IgnoreConfig } from "../filesystem/contracts/visibility.js";
import { createVisibilityPolicy } from "../filesystem/services/visibility/policy.js";
import type { FileToolLimits } from "../file-tool-limits.js";

const SCHEMA_PATH = agentSchemaPath("file-tools.schema.json");

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

interface CompleteFileToolsConfig extends Required<RawFileToolsConfig> {
	limits: FileToolLimits;
	ignore: Required<NonNullable<RawFileToolsConfig["ignore"]>>;
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

/** 拥有一个 file-tools 运行时的配置元数据缓存。 */
export class FileToolsConfigProvider implements FileToolsConfigLoader {
	private readonly cache = new Map<string, ConfigCacheEntry>();
	private readonly pending = new Map<string, Promise<ConfigCacheEntry>>();
	private epoch = 0;
	private disposed = false;

	/** 在访问工作区数据平面之前，先加载用户和调用工作目录（invocation-cwd）的项目 JSONC。 */
	async load(cwd: string): Promise<FileToolsConfigResult> {
		if (this.disposed) return configFailure("File-tools config provider is shut down.");
		const paths = resolveConfigLayerPaths(CONFIG_DEFINITIONS.fileTools, cwd);
		const cacheKey = paths.map((source) => source.path).join("\0");
		const fingerprint = await configLayerFingerprint(paths);
		const cached = this.cache.get(cacheKey);
		if (cached?.fingerprint === fingerprint) return structuredClone(cached.result);

		const pendingKey = `${cacheKey}\0${fingerprint}`;
		const epoch = this.epoch;
		let pending = this.pending.get(pendingKey);
		if (pending === undefined) {
			pending = loadMergedConfig(cwd);
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

async function loadMergedConfig(cwd: string): Promise<ConfigCacheEntry> {
	try {
		const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.fileTools, cwd, createError);
		const [defaultLayer, ...overlayLayers] = loaded.layers;
		await validateConfigValue({
			path: defaultLayer.path,
			label: "file-tools default",
			value: defaultLayer.value,
			layer: "default",
			loadValidator: loadCompleteValidator,
			createError,
		});
		let merged = materializeDefaultConfig(defaultLayer.value as CompleteFileToolsConfig);
		let projectRaw: RawFileToolsConfig | undefined;
		let projectPath: string | undefined;
		for (const layer of overlayLayers) {
			await validateConfigValue({
				path: layer.path,
				label: `file-tools ${layer.kind}`,
				value: layer.value,
				layer: layer.kind,
				loadValidator,
				createError,
			});
			const raw = layer.value as RawFileToolsConfig;
			if (layer.kind === "project") {
				projectRaw = raw;
				projectPath = layer.path;
			} else {
				merged = mergeConfig(merged, raw);
			}
		}
		const result = mergeProjectConfig(merged, projectRaw, projectPath);
		return {
			fingerprint: loaded.fingerprint,
			result: result.ok ? configSuccess(bindConfigFingerprint(result.value, loaded.fingerprint)) : result,
		};
	} catch (error) {
		if (error instanceof FileToolsConfigError) {
			return { fingerprint: await configLayerFingerprint(resolveConfigLayerPaths(CONFIG_DEFINITIONS.fileTools, cwd)), result: configFailure(error.message, error.details) };
		}
		throw error;
	}
}

export function defaultFileToolsConfig(): FileToolsConfig {
	return materializeDefaultConfig(readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("file-tools.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "file-tools",
		createError,
	}) as CompleteFileToolsConfig);
}

function materializeDefaultConfig(raw: CompleteFileToolsConfig): FileToolsConfig {
	const baseVisibility = createVisibilityPolicy();
	const visibility = createVisibilityPolicy({
		ignoredPaths: raw.ignored_path,
		ignore: mergeIgnoreConfig(baseVisibility.ignore, raw.ignore),
	});
	const blockedPaths = [...raw.blocked_path];
	const filesystem: FilesystemPolicy = {
		blockedPaths,
		visibility,
		fingerprint: `defaults\0${JSON.stringify({ blockedPaths, visibility: visibility.fingerprint })}`,
	};
	return { filesystem, limits: { ...raw.limits } };
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
		piignore: { enabled: raw?.piignore ?? base.piignore.enabled },
		gitignore: {
			enabled: raw?.gitignore ?? base.gitignore.enabled,
			trackedFilesBypass: raw?.git_tracked_files_bypass ?? base.gitignore.trackedFilesBypass,
		},
		builtinProfile: raw?.builtin_profile ?? base.builtinProfile,
	};
}

function createError(message: string, details?: Record<string, unknown>): FileToolsConfigError {
	return new FileToolsConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "file-tools", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "file-tools", createError });

function configSuccess(value: FileToolsConfig): FileToolsConfigResult {
	return { ok: true, value };
}

function configFailure(message: string, details?: Record<string, unknown>): FileToolsConfigFailure {
	return { ok: false, error: { message, ...(details === undefined ? {} : { details }) } };
}

function appendUnique(base: readonly string[], extra: readonly string[] | undefined): string[] {
	if (extra === undefined) return [...base];
	return Array.from(new Set([...base, ...extra]));
}
