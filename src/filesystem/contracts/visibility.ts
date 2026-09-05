import type { ExistingPathKind, ExistingRef } from "./path.js";
import type { FsResult } from "./result.js";

export type VisibilityIntent =
	| "list-entry"
	| "traverse"
	| "search"
	| "index"
	| "explicit-read"
	| "explicit-edit";

export type BuiltinIgnoreProfile = "none" | "minimal" | "performance";

export interface IgnoreConfig {
	piignore: {
		enabled: boolean;
	};
	gitignore: {
		enabled: boolean;
		trackedFilesBypass: boolean;
	};
	builtinProfile: BuiltinIgnoreProfile;
}

export type PartialIgnoreConfig = {
	piignore?: Partial<IgnoreConfig["piignore"]>;
	gitignore?: Partial<IgnoreConfig["gitignore"]>;
	builtinProfile?: BuiltinIgnoreProfile;
};

/** Immutable visibility policy produced by the config loader for one invocation cwd. */
export interface VisibilityPolicy {
	readonly ignoredPaths: readonly string[];
	readonly ignore: IgnoreConfig;
	readonly fingerprint: string;
}

export interface VisibilityAnnotation {
	readonly ignored: boolean;
	readonly prune: boolean;
	readonly source?: string;
	readonly rule?: string;
}

export interface VisibilityDirectoryEntry {
	readonly name: string;
	readonly kind: ExistingPathKind;
}

export interface VisibilityOperations {
	evaluate(ref: ExistingRef, intent: VisibilityIntent): Promise<FsResult<VisibilityAnnotation>>;
	/** 复用调用方已有的目录快照，加载只影响该目录后代的 ignore 规则。 */
	prepareDirectory(
		directory: ExistingRef & { readonly kind: "directory" },
		entries: readonly VisibilityDirectoryEntry[],
	): Promise<FsResult<void>>;
}
