import type ignoreFactory from "ignore";

import type { ExistingPathKind } from "../../contracts/path.js";
import type { VisibilityIntent } from "../../contracts/visibility.js";
import type { PathIdentity } from "../../kernel/access-policy.js";
import { NativeFileSystemError } from "../../platform/node/native-filesystem.js";

export type VisibilitySourceType = "builtin" | "gitignore" | "piignore" | "config";

export const SOURCE_PRIORITY: Readonly<Record<VisibilitySourceType, number>> = {
	builtin: 0,
	gitignore: 1,
	piignore: 2,
	config: 3,
};

export interface MatchedIgnoreRule {
	readonly sourceType: VisibilitySourceType;
	readonly sourcePath?: string | undefined;
	readonly pattern: string;
	readonly negated: boolean;
}

export interface VisibilityRuleFile {
	readonly sourceType: "gitignore" | "piignore";
	readonly sourcePath: string;
	readonly absolutePath: string;
	readonly baseDirectory: string;
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
	readonly state: "ignore" | "include";
	readonly rule: MatchedIgnoreRule;
}

export interface VisibilityEvaluateInput extends PathIdentity {
	readonly kind: ExistingPathKind;
	readonly intent: VisibilityIntent;
}

export interface VisibilityDecision {
	readonly ignored: boolean;
	readonly prune: boolean;
	readonly matchedRule?: MatchedIgnoreRule;
}

export function pathDepth(relativePath: string): number {
	return relativePath === "." ? 0 : relativePath.split("/").length;
}

export function rethrowVisibilityAbort(error: unknown): void {
	if (error instanceof NativeFileSystemError && error.code === "aborted") throw error;
}
