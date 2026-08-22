import type { IgnoreConfig, PartialIgnoreConfig, VisibilityPolicy } from "../../contracts/visibility.js";

export const defaultIgnoreConfig: IgnoreConfig = {
	piignore: {
		enabled: true,
	},
	gitignore: {
		enabled: true,
		trackedFilesBypass: true,
	},
	builtinProfile: "minimal",
};

export interface CreateVisibilityPolicyOptions {
	readonly ignoredPaths?: readonly string[];
	readonly ignore?: PartialIgnoreConfig;
	readonly configFingerprint?: string;
}

/** Merge visibility overrides without creating an independent config source. */
export function resolveIgnoreConfig(overrides: PartialIgnoreConfig = {}): IgnoreConfig {
	return {
		piignore: { ...defaultIgnoreConfig.piignore, ...overrides.piignore },
		gitignore: { ...defaultIgnoreConfig.gitignore, ...overrides.gitignore },
		builtinProfile: overrides.builtinProfile ?? defaultIgnoreConfig.builtinProfile,
	};
}

export function createVisibilityPolicy(options: CreateVisibilityPolicyOptions = {}): VisibilityPolicy {
	const ignoredPaths = [...(options.ignoredPaths ?? [])];
	const ignore = resolveIgnoreConfig(options.ignore);
	return {
		ignoredPaths,
		ignore,
		fingerprint: `${options.configFingerprint ?? "defaults"}\0${JSON.stringify({ ignoredPaths, ignore })}`,
	};
}
