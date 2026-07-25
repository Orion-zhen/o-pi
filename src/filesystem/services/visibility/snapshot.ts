import path from "node:path";

import type {
	IgnoreDiagnostic,
	IgnoreTraceEntry,
	MatchedIgnoreRule,
	VisibilityDecision,
	VisibilityEvaluateInput,
	VisibilityExplanation,
	VisibilityExplainInput,
	VisibilityMatchState,
	VisibilityPolicy,
	VisibilitySnapshot,
	VisibilitySourceType,
} from "../../contracts/visibility.js";
import { pathMatchesRule, type PathIdentity } from "../../kernel/access-policy.js";
import {
	SOURCE_PRIORITY,
	type CompiledVisibilityRuleSet,
	type VisibilitySourceMatch,
} from "./model.js";

interface CompiledVisibilitySource {
	readonly sourceType: VisibilitySourceType;
	readonly ruleSets: readonly CompiledVisibilityRuleSet[];
}

export class CompiledVisibilitySnapshot implements VisibilitySnapshot {
	readonly diagnostics: readonly IgnoreDiagnostic[];
	private readonly sources: readonly CompiledVisibilitySource[];
	private readonly negatedRuleSets: readonly CompiledVisibilityRuleSet[];
	private readonly trackedLookup: ReadonlySet<string>;
	private readonly trackedBypassEnabled: boolean;

	constructor(
		readonly generation: number,
		readonly fingerprint: string,
		private readonly root: string,
		ruleSets: readonly CompiledVisibilityRuleSet[],
		diagnostics: readonly IgnoreDiagnostic[],
		trackedPaths: ReadonlySet<string>,
		private readonly policy: VisibilityPolicy,
		private readonly caseInsensitive: boolean,
	) {
		this.diagnostics = diagnostics;
		this.sources = groupRuleSetsBySource(ruleSets);
		this.negatedRuleSets = ruleSets.filter((ruleSet) => ruleSet.hasNegatedRule);
		this.trackedLookup = caseInsensitive
			? new Set(Array.from(trackedPaths, (trackedPath) => trackedPath.toLowerCase()))
			: trackedPaths;
		this.trackedBypassEnabled = policy.ignore.gitignore.trackedFilesBypass
			&& this.sources.some((source) => source.sourceType === "gitignore");
	}

	evaluate(input: VisibilityEvaluateInput): VisibilityDecision {
		const workspacePath = visibilityWorkspacePath(input);
		const normalized = normalizeIgnorePath(workspacePath ?? input.path);
		const tracked = workspacePath !== undefined && this.trackedBypassEnabled && (input.tracked ?? this.isTracked(normalized));
		let winner: VisibilitySourceMatch | undefined;
		if (workspacePath !== undefined) {
			for (const source of this.sources) {
				const sourceMatch = this.matchSource(source, normalized, input.kind);
				if (sourceMatch === undefined || this.isBypassedTrackedIgnore(source.sourceType, sourceMatch, tracked)) continue;
				winner = sourceMatch;
			}
		}
		const configuredRule = this.matchConfiguredRule(input);
		if (configuredRule !== undefined) winner = { state: "ignore", rule: configuredRule };
		const state: VisibilityMatchState = winner?.state ?? "none";
		const ignored = state === "ignore";
		const prune = ignored && canPrune(input.intent) && input.kind === "directory"
			&& (configuredRule !== undefined || !this.hasNegatedRuleForDescendant(normalized));
		const decision: VisibilityDecision = { state, ignored, prune };
		if (winner !== undefined) decision.matchedRule = decisionRule(winner.rule);
		if (this.diagnostics.length > 0) decision.diagnostics = this.diagnostics;
		return decision;
	}

	explain(input: VisibilityExplainInput): VisibilityExplanation {
		const workspacePath = visibilityWorkspacePath(input);
		const normalized = normalizeIgnorePath(workspacePath ?? input.path);
		const tracked = workspacePath !== undefined && this.trackedBypassEnabled && this.isTracked(normalized);
		const trace = workspacePath === undefined ? [] : this.matchTrace(normalized, input.kind, tracked);
		const configuredRule = this.matchConfiguredRule(input);
		if (configuredRule !== undefined) {
			trace.push({
				sourceType: "config",
				sourcePath: "file-tools.jsonc",
				pattern: configuredRule.pattern,
				negated: false,
				result: "ignore",
			});
		}
		const winner = trace[trace.length - 1];
		const ignored = winner?.result === "ignore";
		const prune = ignored && input.kind === "directory"
			&& (configuredRule !== undefined || !this.hasNegatedRuleForDescendant(normalized));
		const explanation: VisibilityExplanation = { path: normalized, ignored, prune, trace };
		if (winner !== undefined) {
			explanation.winner = {
				sourceType: winner.sourceType,
				sourcePath: winner.sourcePath,
				line: winner.line,
				pattern: winner.pattern,
			};
		}
		if (this.diagnostics.length > 0) explanation.diagnostics = this.diagnostics;
		return explanation;
	}

	private matchTrace(pathname: string, kind: VisibilityEvaluateInput["kind"], tracked: boolean): IgnoreTraceEntry[] {
		const trace: IgnoreTraceEntry[] = [];
		for (const source of this.sources) {
			const sourceMatch = this.matchSource(source, pathname, kind);
			if (sourceMatch === undefined || this.isBypassedTrackedIgnore(source.sourceType, sourceMatch, tracked)) continue;
			trace.push({
				sourceType: source.sourceType,
				sourcePath: sourceMatch.rule.sourcePath,
				line: sourceMatch.rule.line,
				pattern: sourceMatch.rule.pattern,
				negated: sourceMatch.rule.negated,
				result: sourceMatch.state,
			});
		}
		return trace;
	}

	private matchSource(
		source: CompiledVisibilitySource,
		pathname: string,
		kind: VisibilityEvaluateInput["kind"],
	): VisibilitySourceMatch | undefined {
		let winner: VisibilitySourceMatch | undefined;
		for (const ruleSet of source.ruleSets) {
			if (!pathIsInsideBase(pathname, ruleSet.baseDirectory)) continue;
			const relative = toBaseRelative(pathname, ruleSet.baseDirectory);
			if (relative === "") continue;
			const testPath = kind === "directory" ? `${relative}/` : relative;
			const ruleSetMatch = ruleSet.matcher.test(testPath);
			if (!ruleSetMatch.ignored && !ruleSetMatch.unignored) continue;
			let parentExcluded = winner?.state === "ignore" && ruleMatchesDirectoryAncestor(winner.rule, relative, kind);
			for (const compiledRule of ruleSet.rules) {
				if (!compiledRule.matcher.ignores(testPath)) continue;
				if (compiledRule.rule.negated) {
					if (!parentExcluded) winner = { state: "include", rule: compiledRule.rule };
				} else {
					winner = { state: "ignore", rule: compiledRule.rule };
					if (compiledRule.directoryOnly && (kind !== "directory" || relative.includes("/"))) parentExcluded = true;
				}
			}
		}
		return winner;
	}

	private isBypassedTrackedIgnore(sourceType: VisibilitySourceType, match: VisibilitySourceMatch, tracked: boolean): boolean {
		return sourceType === "gitignore" && tracked && match.state === "ignore";
	}

	private hasNegatedRuleForDescendant(pathname: string): boolean {
		const descendant = `${pathname}/child`;
		return this.negatedRuleSets.some((ruleSet) => pathIsInsideBase(descendant, ruleSet.baseDirectory));
	}

	private isTracked(pathname: string): boolean {
		return this.trackedLookup.has(this.caseInsensitive ? pathname.toLowerCase() : pathname);
	}

	private matchConfiguredRule(input: VisibilityExplainInput): MatchedIgnoreRule | undefined {
		const workspacePath = input.workspacePath ?? (path.isAbsolute(input.path) ? undefined : normalizeIgnorePath(input.path));
		const absolutePath = input.absolutePath ?? (workspacePath === undefined ? input.path : path.resolve(this.root, workspacePath));
		const identity: PathIdentity = {
			displayPath: input.path,
			absolutePath,
			...(workspacePath === undefined ? {} : { workspacePath }),
		};
		const pattern = this.policy.ignoredPaths.find((rule) => pathMatchesRule(identity, rule));
		if (pattern === undefined) return undefined;
		return {
			sourceType: "config",
			sourcePath: "file-tools.jsonc",
			pattern,
			negated: false,
			baseDirectory: ".",
			priority: SOURCE_PRIORITY.config,
		};
	}
}

function groupRuleSetsBySource(ruleSets: readonly CompiledVisibilityRuleSet[]): CompiledVisibilitySource[] {
	const grouped = new Map<VisibilitySourceType, CompiledVisibilityRuleSet[]>();
	for (const ruleSet of ruleSets) {
		const existing = grouped.get(ruleSet.sourceType);
		if (existing === undefined) grouped.set(ruleSet.sourceType, [ruleSet]);
		else existing.push(ruleSet);
	}
	return Array.from(grouped, ([sourceType, sourceRuleSets]) => ({ sourceType, ruleSets: sourceRuleSets }));
}

function decisionRule(rule: MatchedIgnoreRule): MatchedIgnoreRule {
	return { ...rule, baseDirectory: ".", priority: SOURCE_PRIORITY[rule.sourceType] };
}

function pathIsInsideBase(pathname: string, baseDirectory: string): boolean {
	return baseDirectory === "." || pathname === baseDirectory || pathname.startsWith(`${baseDirectory}/`);
}

function toBaseRelative(pathname: string, baseDirectory: string): string {
	return baseDirectory === "." ? pathname : pathname.slice(baseDirectory.length + 1);
}

function normalizeIgnorePath(pathname: string): string {
	return pathname.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "") || ".";
}

function ruleMatchesDirectoryAncestor(
	rule: MatchedIgnoreRule,
	relative: string,
	kind: VisibilityEvaluateInput["kind"],
): boolean {
	if (!rule.pattern.trimEnd().endsWith("/")) return false;
	if (kind !== "directory") return true;
	return relative.includes("/");
}

function visibilityWorkspacePath(input: VisibilityExplainInput): string | undefined {
	if (input.workspacePath !== undefined) return input.workspacePath;
	return input.absolutePath === undefined ? input.path : undefined;
}

function canPrune(intent: VisibilityEvaluateInput["intent"]): boolean {
	return intent === "traverse" || intent === "search" || intent === "index";
}
