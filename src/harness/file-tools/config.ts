import {
	CONFIG_DEFINITIONS,
	ConfigError,
	configLayerFingerprint,
	loadValidatedConfigLayers,
	resolveConfigLayerPaths,
} from "../config-loader.ts";
import { ConfigCache, type ConfigSnapshot } from "../config-cache.ts";
import type { FilesystemPolicy } from "../filesystem/contracts/policy.ts";
import type { BuiltinIgnoreProfile } from "../filesystem/contracts/visibility.ts";
import type { FileToolLimits } from "../file-tool-limits.ts";

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

export interface FileToolsConfigFailure {
	readonly ok: false;
	readonly error: { readonly message: string; readonly details?: Record<string, unknown> };
}

export type FileToolsConfigResult =
	| { readonly ok: true; readonly value: FileToolsConfig }
	| FileToolsConfigFailure;

/** 拥有一个文件工具运行时的配置元数据缓存。 */
export class FileToolsConfigProvider {
	private readonly cache = new ConfigCache(CONFIG_DEFINITIONS.fileTools, loadMergedConfig);

	load(cwd: string): Promise<FileToolsConfigResult> {
		return this.cache.load(cwd);
	}

	dispose(): void {
		this.cache.clear();
	}
}

async function loadMergedConfig(cwd: string): Promise<ConfigSnapshot<FileToolsConfigResult>> {
	try {
		const loaded = await loadValidatedConfigLayers(CONFIG_DEFINITIONS.fileTools, cwd);
		const [defaultLayer, ...overlayLayers] = loaded.layers;
		let merged = defaultLayer.value as CompleteFileToolsConfig;
		for (const layer of overlayLayers) {
			const raw = layer.value as RawFileToolsConfig;
			const project = layer.kind === "project";
			const projectFailure = project ? projectIgnoreFailure(raw, layer.path) : undefined;
			if (projectFailure !== undefined) return { fingerprint: loaded.fingerprint, value: projectFailure };
			merged = {
				blocked_path: project ? appendUnique(merged.blocked_path, raw.blocked_path) : raw.blocked_path ?? merged.blocked_path,
				ignored_path: project ? appendUnique(merged.ignored_path, raw.ignored_path) : raw.ignored_path ?? merged.ignored_path,
				limits: { ...merged.limits, ...raw.limits },
				ignore: { ...merged.ignore, ...raw.ignore },
			};
		}
		return {
			fingerprint: loaded.fingerprint,
			value: { ok: true, value: materializeConfig(merged) },
		};
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		return {
			fingerprint: await configLayerFingerprint(resolveConfigLayerPaths(CONFIG_DEFINITIONS.fileTools, cwd)),
			value: configFailure(error.message, error.details),
		};
	}
}

function materializeConfig(raw: CompleteFileToolsConfig): FileToolsConfig {
	return {
		filesystem: {
			blockedPaths: raw.blocked_path,
			visibility: {
				ignoredPaths: raw.ignored_path,
				ignore: {
					piignore: { enabled: raw.ignore.piignore },
					gitignore: { enabled: raw.ignore.gitignore, trackedFilesBypass: raw.ignore.git_tracked_files_bypass },
					builtinProfile: raw.ignore.builtin_profile,
				},
			},
		},
		limits: raw.limits,
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

function configFailure(message: string, details?: Record<string, unknown>): FileToolsConfigFailure {
	return { ok: false, error: { message, ...(details === undefined ? {} : { details }) } };
}

function appendUnique(base: readonly string[], extra: readonly string[] | undefined): string[] {
	return extra === undefined ? [...base] : [...new Set([...base, ...extra])];
}
