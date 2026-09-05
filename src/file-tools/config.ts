import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	configLayerFingerprint,
	createCompleteSchemaValidator,
	createSchemaValidator,
	loadConfigLayers,
	resolveConfigLayerPaths,
	validateConfigValue,
} from "../config-loader.js";
import type { FilesystemPolicy } from "../filesystem/contracts/policy.js";
import type { BuiltinIgnoreProfile } from "../filesystem/contracts/visibility.js";
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

/** 拥有一个文件工具运行时的配置元数据缓存。 */
export class FileToolsConfigProvider implements FileToolsConfigLoader {
	private readonly cache = new Map<string, ConfigCacheEntry>();
	private readonly pending = new Map<string, Promise<ConfigCacheEntry>>();
	private disposed = false;

	/** 工作区 I/O 前加载用户配置和调用目录的项目配置。 */
	async load(cwd: string): Promise<FileToolsConfigResult> {
		if (this.disposed) return configFailure("File-tools config provider is shut down.");
		const paths = resolveConfigLayerPaths(CONFIG_DEFINITIONS.fileTools, cwd);
		const cacheKey = paths.map((source) => source.path).join("\0");
		const fingerprint = await configLayerFingerprint(paths);
		const cached = this.cache.get(cacheKey);
		if (cached?.fingerprint === fingerprint) return structuredClone(cached.result);

		const pendingKey = `${cacheKey}\0${fingerprint}`;
		let pending = this.pending.get(pendingKey);
		if (pending === undefined) {
			pending = loadMergedConfig(cwd);
			this.pending.set(pendingKey, pending);
		}
		try {
			const loaded = await pending;
			if (this.disposed) return configFailure("File-tools config provider is shut down.");
			this.cache.set(cacheKey, loaded);
			return structuredClone(loaded.result);
		} finally {
			if (this.pending.get(pendingKey) === pending) this.pending.delete(pendingKey);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.cache.clear();
		this.pending.clear();
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
		let merged = defaultLayer.value as CompleteFileToolsConfig;
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
			const project = layer.kind === "project";
			const projectFailure = project ? projectIgnoreFailure(raw, layer.path) : undefined;
			if (projectFailure !== undefined) return { fingerprint: loaded.fingerprint, result: projectFailure };
			merged = {
				blocked_path: project ? appendUnique(merged.blocked_path, raw.blocked_path) : raw.blocked_path ?? merged.blocked_path,
				ignored_path: project ? appendUnique(merged.ignored_path, raw.ignored_path) : raw.ignored_path ?? merged.ignored_path,
				limits: { ...merged.limits, ...raw.limits },
				ignore: { ...merged.ignore, ...raw.ignore },
			};
		}
		return {
			fingerprint: loaded.fingerprint,
			result: { ok: true, value: materializeConfig(merged, loaded.fingerprint) },
		};
	} catch (error) {
		if (!(error instanceof FileToolsConfigError)) throw error;
		return {
			fingerprint: await configLayerFingerprint(resolveConfigLayerPaths(CONFIG_DEFINITIONS.fileTools, cwd)),
			result: configFailure(error.message, error.details),
		};
	}
}

/** 原始配置合并完毕后，只构建一次运行时策略和最终指纹。 */
function materializeConfig(raw: CompleteFileToolsConfig, fingerprint: string): FileToolsConfig {
	const visibility = createVisibilityPolicy({
		ignoredPaths: raw.ignored_path,
		ignore: {
			piignore: { enabled: raw.ignore.piignore },
			gitignore: { enabled: raw.ignore.gitignore, trackedFilesBypass: raw.ignore.git_tracked_files_bypass },
			builtinProfile: raw.ignore.builtin_profile,
		},
		configFingerprint: fingerprint,
	});
	const blockedPaths = [...raw.blocked_path];
	return {
		filesystem: {
			blockedPaths,
			visibility,
			fingerprint: `${fingerprint}\0${JSON.stringify({ blockedPaths, visibility: visibility.fingerprint })}`,
		},
		limits: { ...raw.limits },
	};
}

function projectIgnoreFailure(raw: RawFileToolsConfig, sourcePath: string): FileToolsConfigFailure | undefined {
	const unsupported = ["piignore", "gitignore", "git_tracked_files_bypass"].filter((key) => key in (raw.ignore ?? {}));
	if (unsupported.length > 0) {
		return configFailure("project file-tools config cannot change user ignore safety switches.", {
			path: sourcePath,
			fields: unsupported.map((key) => `ignore.${key}`),
		});
	}
}

function createError(message: string, details?: Record<string, unknown>): FileToolsConfigError {
	return new FileToolsConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "file-tools", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "file-tools", createError });

function configFailure(message: string, details?: Record<string, unknown>): FileToolsConfigFailure {
	return { ok: false, error: { message, ...(details === undefined ? {} : { details }) } };
}

function appendUnique(base: readonly string[], extra: readonly string[] | undefined): string[] {
	return extra === undefined ? [...base] : [...new Set([...base, ...extra])];
}
