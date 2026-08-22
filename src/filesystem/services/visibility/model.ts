import type ignoreFactory from "ignore";

import type { ExistingPathKind } from "../../contracts/path.js";
import type { VisibilityIntent } from "../../contracts/visibility.js";
import { NativeFileSystemError } from "../../platform/node/native-filesystem.js";

export type VisibilitySourceType = "builtin" | "gitignore" | "piignore" | "config";
export type VisibilityMatchState = "none" | "ignore" | "include";

export const SOURCE_PRIORITY: Readonly<Record<VisibilitySourceType, number>> = {
	builtin: 0,
	gitignore: 1,
	piignore: 2,
	config: 3,
};

export interface MatchedIgnoreRule {
	readonly sourceType: VisibilitySourceType;
	readonly sourcePath?: string | undefined;
	readonly line?: number | undefined;
	readonly pattern: string;
	readonly negated: boolean;
	readonly baseDirectory: string;
	readonly priority: number;
}

export interface VisibilityRuleFile {
	readonly sourceType: "gitignore" | "piignore";
	readonly sourcePath: string;
	readonly absolutePath: string;
	readonly baseDirectory: string;
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

export interface VisibilityEvaluateInput {
	readonly path: string;
	readonly absolutePath?: string | undefined;
	readonly workspacePath?: string | undefined;
	readonly kind: ExistingPathKind;
	readonly intent: VisibilityIntent;
	readonly tracked?: boolean;
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
