import { createHash } from "node:crypto";

import { agentSchemaPath, createSchemaValidator, readOptionalJsoncConfigWithSchema, userAgentConfigPath } from "../config-loader.js";
import { RepoMapError } from "./errors.js";
import { DEFAULT_REPO_MAP_OUTPUT_CONFIG, type RepoMapOutputConfig } from "./output-config.js";
export { repoMapCacheRoot } from "./cache-path.js";

const USER_CONFIG_ENV = "PI_REPO_MAP_CONFIG";

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

const defaults: RepoMapConfig = {
	scan: { max_files: 100_000, max_file_bytes: 1024 * 1024, concurrency: 8 },
	cache: { max_generations: 2 },
	output: { ...DEFAULT_REPO_MAP_OUTPUT_CONFIG },
};

export async function loadRepoMapConfig(): Promise<RepoMapConfig> {
	try {
		const parsed = await readOptionalJsoncConfigWithSchema({
			path: userAgentConfigPath("repo-map.jsonc", USER_CONFIG_ENV),
			label: "repo-map",
			loadValidator,
			createError: (message, details) => new RepoMapConfigError(message, details),
		});
		if (parsed === undefined) return defaultRepoMapConfig();
		const raw = parsed as RawRepoMapConfig;
		return {
			scan: { ...defaults.scan, ...raw.scan },
			cache: { ...defaults.cache, ...raw.cache },
			output: { ...defaults.output, ...raw.output },
		};
	} catch (error) {
		if (error instanceof RepoMapConfigError) throw new RepoMapError("CONFIG_ERROR", error.message, error.details);
		throw error;
	}
}

export function defaultRepoMapConfig(): RepoMapConfig {
	return structuredClone(defaults);
}

/** Preserve existing generation fingerprint inputs while excluding model-output budgets. */
export function repoMapConfigFingerprint(config: RepoMapConfig): string {
	return createHash("sha256").update(JSON.stringify({ scan: config.scan, cache: config.cache })).digest("hex");
}

class RepoMapConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
	}
}

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("repo-map.schema.json"),
	label: "repo-map",
	createError: (message, details) => new RepoMapConfigError(message, details),
});
