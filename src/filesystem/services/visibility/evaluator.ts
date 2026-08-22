import path from "node:path";

import type { VisibilityPolicy } from "../../contracts/visibility.js";
import { CompiledPathRuleMatcher, type PathIdentity } from "../../kernel/access-policy.js";
import {
	SOURCE_PRIORITY,
	type CompiledVisibilityRuleSet,
	type MatchedIgnoreRule,
	type VisibilityDecision,
	type VisibilityEvaluateInput,
	type VisibilityMatchState,
	type VisibilitySourceMatch,
	type VisibilitySourceType,
} from "./model.js";

interface CompiledVisibilitySource {
	readonly sourceType: VisibilitySourceType;
	readonly ruleSets: readonly CompiledVisibilityRuleSet[];
}

/** 只评估已加载的可见性规则，不发现或读取规则文件。 */
export class VisibilityEvaluator {
	private readonly sources: readonly CompiledVisibilitySource[];
	private readonly negatedRuleSets: readonly CompiledVisibilityRuleSet[];
	private readonly trackedLookup: ReadonlySet<string>;
	private readonly trackedBypassEnabled: boolean;
	private readonly configuredRules: CompiledPathRuleMatcher;

	constructor(
		private readonly root: string,
		ruleSets: readonly CompiledVisibilityRuleSet[],
		trackedPaths: ReadonlySet<string>,
		policy: VisibilityPolicy,
		private readonly caseInsensitive: boolean,
	) {
		this.sources = groupRuleSetsBySource(ruleSets);
		this.negatedRuleSets = ruleSets.filter((ruleSet) => ruleSet.hasNegatedRule);
		this.trackedLookup = caseInsensitive
			? new Set(Array.from(trackedPaths, (trackedPath) => trackedPath.toLowerCase()))
			: trackedPaths;
		this.trackedBypassEnabled = policy.ignore.gitignore.trackedFilesBypass
			&& this.sources.some((source) => source.sourceType === "gitignore");
		this.configuredRules = new CompiledPathRuleMatcher(policy.ignoredPaths);
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
		return {
			ignored,
			prune,
			...(winner === undefined ? {} : { matchedRule: winner.rule }),
		};
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
			if (relative === "" || relative === ".") continue;
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

	private matchConfiguredRule(input: VisibilityEvaluateInput): MatchedIgnoreRule | undefined {
		const workspacePath = input.workspacePath ?? (path.isAbsolute(input.path) ? undefined : normalizeIgnorePath(input.path));
		const absolutePath = input.absolutePath ?? (workspacePath === undefined ? input.path : path.resolve(this.root, workspacePath));
		const identity: PathIdentity = {
			displayPath: input.path,
			absolutePath,
			...(workspacePath === undefined ? {} : { workspacePath }),
		};
		const pattern = this.configuredRules.match(identity);
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

function visibilityWorkspacePath(input: VisibilityEvaluateInput): string | undefined {
	if (input.workspacePath !== undefined) return input.workspacePath;
	return input.absolutePath === undefined ? input.path : undefined;
}

function canPrune(intent: VisibilityEvaluateInput["intent"]): boolean {
	return intent === "traverse" || intent === "search" || intent === "index";
}
