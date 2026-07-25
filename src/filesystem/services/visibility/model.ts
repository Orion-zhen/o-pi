import type ignoreFactory from "ignore";

import type {
	MatchedIgnoreRule,
	VisibilityMatchState,
	VisibilitySnapshot,
	VisibilitySourceType,
} from "../../contracts/visibility.js";
import { NativeFileSystemError } from "../../platform/node/native-filesystem.js";

export const SOURCE_PRIORITY: Readonly<Record<VisibilitySourceType, number>> = {
	builtin: 0,
	global: 1,
	"git-info-exclude": 2,
	gitignore: 3,
	piignore: 4,
	session: 5,
	config: 6,
};

export interface VisibilityRuleFile {
	readonly sourceType: VisibilitySourceType;
	readonly sourcePath: string;
	readonly absolutePath: string;
	readonly baseDirectory: string;
	readonly priority: number;
	readonly stamp: string;
}

export interface VisibilityDirectoryStamp {
	readonly absolutePath: string;
	readonly stamp: string;
}

export interface CompiledVisibilityRuleSet {
	readonly sourceType: VisibilitySourceType;
	readonly sourcePath?: string | undefined;
	readonly baseDirectory: string;
	readonly priority: number;
	readonly matcher: ReturnType<typeof ignoreFactory>;
	readonly rules: readonly CompiledVisibilityRule[];
	readonly hasNegatedRule: boolean;
}

export interface CompiledVisibilityRule {
	readonly rule: MatchedIgnoreRule;
	readonly matcher: ReturnType<typeof ignoreFactory>;
	readonly directoryOnly: boolean;
}

export interface VisibilitySourceMatch {
	readonly state: Exclude<VisibilityMatchState, "none">;
	readonly rule: MatchedIgnoreRule;
}

export interface VisibilitySnapshotCacheEntry {
	readonly fingerprint: string;
	readonly snapshot: VisibilitySnapshot;
	readonly directories: readonly VisibilityDirectoryStamp[];
	readonly ruleFiles: readonly VisibilityRuleFile[];
	readonly trackedFingerprint: string;
}

export function pathDepth(relativePath: string): number {
	return relativePath === "." ? 0 : relativePath.split("/").length;
}

export function rethrowVisibilityAbort(error: unknown): void {
	if (error instanceof NativeFileSystemError && error.code === "aborted") throw error;
}
