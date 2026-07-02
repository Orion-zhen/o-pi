import type { LsEntryType } from "../types.js";

export type IgnoreSourceType = "builtin" | "gitignore" | "piignore" | "git-info-exclude" | "global" | "session";

export type IgnoreMatchState = "none" | "ignore" | "include";

export type IgnoreIntent = "list-entry" | "traverse" | "search" | "index" | "explicit-read" | "explicit-edit";

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

export interface IgnoreDiagnostic {
	sourcePath: string;
	line?: number;
	code: "IGNORE_FILE_READ_ERROR" | "INVALID_IGNORE_PATTERN" | "UNSUPPORTED_IGNORE_ENCODING";
	message: string;
}

export interface MatchedIgnoreRule {
	sourceType: IgnoreSourceType;
	sourcePath?: string | undefined;
	line?: number | undefined;
	pattern: string;
	negated: boolean;
	baseDirectory: string;
	priority: number;
}

export interface IgnoreDecision {
	state: IgnoreMatchState;
	ignored: boolean;
	prune: boolean;
	matchedRule?: MatchedIgnoreRule;
	diagnostics?: IgnoreDiagnostic[];
}

export interface IgnoreTraceEntry {
	sourceType: IgnoreSourceType;
	sourcePath?: string | undefined;
	line?: number | undefined;
	pattern: string;
	negated: boolean;
	result: "ignore" | "include";
}

export interface IgnoreExplanation {
	path: string;
	ignored: boolean;
	prune: boolean;
	trace: IgnoreTraceEntry[];
	winner?: Omit<MatchedIgnoreRule, "negated" | "baseDirectory" | "priority">;
	diagnostics?: IgnoreDiagnostic[];
}

export interface IgnoreEvaluateInput {
	path: string;
	kind: LsEntryType;
	intent: IgnoreIntent;
	tracked?: boolean;
}

export interface IgnoreExplainInput {
	path: string;
	kind: LsEntryType;
}

export interface IgnoreSnapshot {
	readonly generation: number;
	evaluate(input: IgnoreEvaluateInput): IgnoreDecision;
	explain(input: IgnoreExplainInput): IgnoreExplanation;
}

export interface IgnoreEngine {
	createSnapshot(root: string, config?: PartialIgnoreConfig): Promise<IgnoreSnapshot>;
	invalidate(root?: string): void;
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
