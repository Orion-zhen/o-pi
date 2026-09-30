import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import type { BuiltinIgnoreProfile, IgnoreConfig } from "../../../src/harness/filesystem/contracts/visibility.ts";

export type PartialIgnoreConfig = { [K in keyof IgnoreConfig]?: Partial<IgnoreConfig[K]> };

export function createVisibilityPolicy(options: { ignore?: PartialIgnoreConfig; ignoredPaths?: readonly string[] } = {}) {
	const { ignore } = parse(readFileSync(new URL("../../../agent/defaults/file-tools.jsonc", import.meta.url), "utf8")) as {
		ignore: { piignore: boolean; gitignore: boolean; git_tracked_files_bypass: boolean; builtin_profile: BuiltinIgnoreProfile };
	};
	return {
		ignoredPaths: options.ignoredPaths ?? [],
		ignore: {
			piignore: { enabled: ignore.piignore, ...options.ignore?.piignore },
			gitignore: { enabled: ignore.gitignore, trackedFilesBypass: ignore.git_tracked_files_bypass, ...options.ignore?.gitignore },
			builtinProfile: options.ignore?.builtinProfile ?? ignore.builtin_profile,
		},
	};
}
