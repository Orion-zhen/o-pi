import type { IgnoreConfig, PartialIgnoreConfig } from "./ignore-types.js";

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

/** 合并调用方覆盖项；不暴露独立配置文件，避免配置来源分叉。 */
export function resolveIgnoreConfig(overrides: PartialIgnoreConfig = {}): IgnoreConfig {
	return {
		piignore: { ...defaultIgnoreConfig.piignore, ...overrides.piignore },
		gitignore: { ...defaultIgnoreConfig.gitignore, ...overrides.gitignore },
		gitInfoExclude: overrides.gitInfoExclude ?? defaultIgnoreConfig.gitInfoExclude,
		globalGitignore: overrides.globalGitignore ?? defaultIgnoreConfig.globalGitignore,
		builtinProfile: overrides.builtinProfile ?? defaultIgnoreConfig.builtinProfile,
		caseSensitivity: overrides.caseSensitivity ?? defaultIgnoreConfig.caseSensitivity,
		diagnostics: overrides.diagnostics ?? defaultIgnoreConfig.diagnostics,
		sessionRules: overrides.sessionRules ?? defaultIgnoreConfig.sessionRules,
	};
}
