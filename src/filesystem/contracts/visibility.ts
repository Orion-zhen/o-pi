import type { ExistingPathKind, ExistingRef } from "./path.js";
import type { FsOperationContext, FsResult } from "./result.js";

export type VisibilityIntent =
	| "list-entry"
	| "traverse"
	| "search"
	| "index"
	| "explicit-read"
	| "explicit-edit";

export type VisibilitySourceType = "builtin" | "gitignore" | "piignore" | "git-info-exclude" | "global" | "session" | "config";
export type VisibilityMatchState = "none" | "ignore" | "include";
export type BuiltinIgnoreProfile = "none" | "minimal" | "performance";
export type CaseSensitivity = "sensitive" | "insensitive" | "auto";

export interface SessionIgnoreRule {
	action: "include" | "ignore";
	pattern: string;
}

export interface IgnoreConfig {
	piignore: {
		enabled: boolean;
		filename: string;
		nested: boolean;
	};
	gitignore: {
		enabled: boolean;
		nested: boolean;
		trackedFilesBypass: boolean;
	};
	gitInfoExclude: boolean;
	globalGitignore: boolean;
	builtinProfile: BuiltinIgnoreProfile;
	caseSensitivity: CaseSensitivity;
	diagnostics: "silent" | "warn" | "strict";
	sessionRules: SessionIgnoreRule[];
}

export type PartialIgnoreConfig = {
	piignore?: Partial<IgnoreConfig["piignore"]>;
	gitignore?: Partial<IgnoreConfig["gitignore"]>;
	gitInfoExclude?: boolean;
	globalGitignore?: boolean;
	builtinProfile?: BuiltinIgnoreProfile;
	caseSensitivity?: CaseSensitivity;
	diagnostics?: IgnoreConfig["diagnostics"];
	sessionRules?: SessionIgnoreRule[];
};

/** Immutable visibility policy produced by the config loader for one invocation cwd. */
export interface VisibilityPolicy {
	readonly ignoredPaths: readonly string[];
	readonly ignore: IgnoreConfig;
	readonly fingerprint: string;
}

export interface IgnoreDiagnostic {
	sourcePath: string;
	line?: number;
	code: "IGNORE_FILE_READ_ERROR" | "INVALID_IGNORE_PATTERN" | "UNSUPPORTED_IGNORE_ENCODING";
	message: string;
}

export interface MatchedIgnoreRule {
	sourceType: VisibilitySourceType;
	sourcePath?: string | undefined;
	line?: number | undefined;
	pattern: string;
	negated: boolean;
	baseDirectory: string;
	priority: number;
}

export interface VisibilityDecision {
	state: VisibilityMatchState;
	ignored: boolean;
	prune: boolean;
	matchedRule?: MatchedIgnoreRule;
	diagnostics?: readonly IgnoreDiagnostic[];
}

export interface IgnoreTraceEntry {
	sourceType: VisibilitySourceType;
	sourcePath?: string | undefined;
	line?: number | undefined;
	pattern: string;
	negated: boolean;
	result: "ignore" | "include";
}

export interface VisibilityExplanation {
	path: string;
	ignored: boolean;
	prune: boolean;
	trace: IgnoreTraceEntry[];
	winner?: Omit<MatchedIgnoreRule, "negated" | "baseDirectory" | "priority">;
	diagnostics?: readonly IgnoreDiagnostic[];
}

export interface VisibilityPathIdentity {
	readonly path: string;
	readonly absolutePath?: string | undefined;
	readonly workspacePath?: string | undefined;
}

export interface VisibilityEvaluateInput extends VisibilityPathIdentity {
	kind: ExistingPathKind;
	intent: VisibilityIntent;
	tracked?: boolean;
}

export interface VisibilityExplainInput extends VisibilityPathIdentity {
	kind: ExistingPathKind;
}

export interface VisibilitySnapshot {
	readonly generation: number;
	readonly fingerprint: string;
	readonly diagnostics: readonly IgnoreDiagnostic[];
	evaluate(input: VisibilityEvaluateInput): VisibilityDecision;
	explain(input: VisibilityExplainInput): VisibilityExplanation;
}

export interface VisibilityService {
	createSnapshot(root: string, policy: VisibilityPolicy, context?: FsOperationContext): Promise<VisibilitySnapshot>;
	invalidate(root?: string): void;
}

export interface VisibilityAnnotation {
	readonly ignored: boolean;
	readonly prune: boolean;
	readonly source?: string;
	readonly rule?: string;
}

export interface VisibilitySnapshotInfo {
	readonly fingerprint: string;
	readonly diagnostics: readonly string[];
}

export interface VisibilityOperations {
	readonly snapshot: VisibilitySnapshotInfo;
	evaluate(ref: ExistingRef, intent: VisibilityIntent, context: FsOperationContext): Promise<FsResult<VisibilityAnnotation>>;
}
