import { createHash } from "node:crypto";

import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadConfigLayers,
	mergeConfigValues,
	readDefaultJsoncConfigSync,
	validateConfigValue,
} from "../../config-loader.js";
import { RepoMapError } from "../core/errors.js";
import type { RepoMapOutputConfig } from "./output-config.js";
export { repoMapCacheRoot } from "../repository/cache-path.js";

const SCHEMA_PATH = agentSchemaPath("repo-map.schema.json");

export interface RepoMapConfig {
	scan: {
		max_files: number;
		max_file_bytes: number;
		concurrency: number;
	};
	cache: {
		max_generations: number;
	};
	output: RepoMapOutputConfig;
}

interface RawRepoMapConfig {
	scan?: Partial<RepoMapConfig["scan"]>;
	cache?: Partial<RepoMapConfig["cache"]>;
	output?: Partial<RepoMapConfig["output"]>;
}

interface CompleteRepoMapConfig extends Required<RawRepoMapConfig> {
	scan: RepoMapConfig["scan"];
	cache: RepoMapConfig["cache"];
	output: RepoMapConfig["output"];
}

export async function loadRepoMapConfig(): Promise<RepoMapConfig> {
	try {
		const loaded = await loadConfigLayers(CONFIG_DEFINITIONS.repoMap, process.cwd(), createError);
		let merged: unknown = {};
		for (const layer of loaded.layers) {
			await validateConfigValue({
				path: layer.path,
				label: `repo-map ${layer.kind}`,
				value: layer.value,
				layer: layer.kind,
				loadValidator: layer.kind === "default" ? loadCompleteValidator : loadValidator,
				createError,
			});
			merged = mergeConfigValues(merged, layer.value);
		}
		return materializeConfig(merged as CompleteRepoMapConfig);
	} catch (error) {
		if (error instanceof RepoMapConfigError) throw new RepoMapError("CONFIG_ERROR", error.message, error.details);
		throw error;
	}
}

export function defaultRepoMapConfig(): RepoMapConfig {
	return materializeConfig(readDefaultConfig());
}

/** Preserve existing generation fingerprint inputs while excluding model-output budgets. */
export function repoMapConfigFingerprint(config: RepoMapConfig): string {
	return createHash("sha256").update(JSON.stringify({ scan: config.scan, cache: config.cache })).digest("hex");
}

function materializeConfig(raw: CompleteRepoMapConfig): RepoMapConfig {
	return { scan: { ...raw.scan }, cache: { ...raw.cache }, output: { ...raw.output } };
}

class RepoMapConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
	}
}

function readDefaultConfig(): CompleteRepoMapConfig {
	return readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("repo-map.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "repo-map",
		createError,
	}) as CompleteRepoMapConfig;
}

function createError(message: string, details?: Record<string, unknown>): RepoMapConfigError {
	return new RepoMapConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "repo-map", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "repo-map", createError });
