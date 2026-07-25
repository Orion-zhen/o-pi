import type { IgnoreConfig, PartialIgnoreConfig, VisibilityPolicy } from "../../contracts/visibility.js";

export const defaultIgnoreConfig: IgnoreConfig = {
	piignore: {
		enabled: true,
		filename: ".piignore",
		nested: true,
	},
	gitignore: {
		enabled: true,
		nested: true,
		trackedFilesBypass: true,
	},
	gitInfoExclude: false,
	globalGitignore: false,
	builtinProfile: "minimal",
	caseSensitivity: "auto",
	diagnostics: "warn",
	sessionRules: [],
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
		gitInfoExclude: overrides.gitInfoExclude ?? defaultIgnoreConfig.gitInfoExclude,
		globalGitignore: overrides.globalGitignore ?? defaultIgnoreConfig.globalGitignore,
		builtinProfile: overrides.builtinProfile ?? defaultIgnoreConfig.builtinProfile,
		caseSensitivity: overrides.caseSensitivity ?? defaultIgnoreConfig.caseSensitivity,
		diagnostics: overrides.diagnostics ?? defaultIgnoreConfig.diagnostics,
		sessionRules: overrides.sessionRules === undefined ? [...defaultIgnoreConfig.sessionRules] : [...overrides.sessionRules],
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
