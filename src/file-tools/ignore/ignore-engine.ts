import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignoreFactory from "ignore";
import { isProtectedWorkspacePath } from "../path-security.js";
import { resolveIgnoreConfig } from "./ignore-config.js";
import { loadGitTrackedFiles } from "./git-tracked-files.js";
import type {
	IgnoreConfig,
	IgnoreDecision,
	IgnoreDiagnostic,
	IgnoreEngine,
	IgnoreEvaluateInput,
	IgnoreExplainInput,
	IgnoreExplanation,
	IgnoreMatchState,
	IgnoreSnapshot,
	IgnoreSourceType,
	IgnoreTraceEntry,
	MatchedIgnoreRule,
	PartialIgnoreConfig,
	SessionIgnoreRule,
} from "./ignore-types.js";

const SOURCE_PRIORITY: Record<IgnoreSourceType, number> = {
	builtin: 0,
	global: 1,
	"git-info-exclude": 2,
	gitignore: 3,
	piignore: 4,
	session: 5,
};

const BUILTIN_RULES: Record<IgnoreConfig["builtinProfile"], string[]> = {
	none: [],
	minimal: ["node_modules/", ".DS_Store"],
	performance: ["node_modules/", "target/", ".venv/", "__pycache__/", ".pytest_cache/", ".gradle/", ".next/cache/"],
};

interface RuleFile {
	sourceType: IgnoreSourceType;
	sourcePath: string;
	absolutePath: string;
	baseDirectory: string;
	priority: number;
	mtimeMs: number;
	size: number;
}

interface CompiledRuleSet {
	sourceType: IgnoreSourceType;
	sourcePath?: string | undefined;
	baseDirectory: string;
	priority: number;
	rules: CompiledRule[];
	hasNegatedRule: boolean;
}

interface CompiledRule {
	rule: MatchedIgnoreRule;
	matcher: ReturnType<typeof ignoreFactory>;
	directoryOnly: boolean;
}

interface SourceMatch {
	state: Exclude<IgnoreMatchState, "none">;
	rule: MatchedIgnoreRule;
}

interface SnapshotCacheEntry {
	fingerprint: string;
	snapshot: IgnoreSnapshot;
}

let nextGeneration = 1;

class WorkspaceIgnoreEngine implements IgnoreEngine {
	private readonly cache = new Map<string, SnapshotCacheEntry>();

	async createSnapshot(root: string, overrides: PartialIgnoreConfig = {}): Promise<IgnoreSnapshot> {
		const config = resolveIgnoreConfig(overrides);
		const tracked = await loadGitTrackedFiles(root);
		const caseInsensitive = resolveCaseInsensitive(config, tracked.ignoreCase);
		const [ruleFiles, discoveryDiagnostics] = await discoverRuleFiles(root, config);
		const { ruleSets, diagnostics } = await compileRuleSets(root, ruleFiles, config, caseInsensitive, discoveryDiagnostics);
		const fingerprint = buildFingerprint(config, caseInsensitive, ruleFiles, tracked.paths, diagnostics);
		const cacheKey = `${root}:${JSON.stringify(config)}:${caseInsensitive}`;
		const cached = this.cache.get(cacheKey);
		if (cached?.fingerprint === fingerprint) return cached.snapshot;

		const snapshot = new IgnoreSnapshotImpl(nextGeneration, ruleSets, diagnostics, tracked.paths, config, caseInsensitive);
		nextGeneration += 1;
		this.cache.set(cacheKey, { fingerprint, snapshot });
		return snapshot;
	}

	invalidate(root?: string): void {
		if (root === undefined) {
			this.cache.clear();
			return;
		}
		for (const key of this.cache.keys()) {
			if (key.startsWith(`${root}:`)) this.cache.delete(key);
		}
	}
}

class IgnoreSnapshotImpl implements IgnoreSnapshot {
	readonly generation: number;

	constructor(
		generation: number,
		private readonly ruleSets: CompiledRuleSet[],
		private readonly diagnostics: IgnoreDiagnostic[],
		private readonly trackedPaths: ReadonlySet<string>,
		private readonly config: IgnoreConfig,
		private readonly caseInsensitive: boolean,
	) {
		this.generation = generation;
	}

	evaluate(input: IgnoreEvaluateInput): IgnoreDecision {
		const normalized = normalizeIgnorePath(input.path);
		const tracked = input.tracked ?? this.isTracked(normalized);
		const trace = this.matchTrace(normalized, input.kind, tracked);
		const winner = trace[trace.length - 1];
		const state: IgnoreMatchState = winner === undefined ? "none" : winner.result;
		const matchedRule = winner === undefined ? undefined : traceRuleToMatched(winner);
		const ignored = state === "ignore";
		const prune = ignored && input.kind === "directory" && !this.hasNegatedRuleForDescendant(normalized);
		const decision: IgnoreDecision = { state, ignored, prune };
		if (matchedRule !== undefined) decision.matchedRule = matchedRule;
		if (this.diagnostics.length > 0) decision.diagnostics = this.diagnostics;
		return decision;
	}

	explain(input: IgnoreExplainInput): IgnoreExplanation {
		const normalized = normalizeIgnorePath(input.path);
		const trace = this.matchTrace(normalized, input.kind, this.isTracked(normalized));
		const winner = trace[trace.length - 1];
		const ignored = winner?.result === "ignore";
		const prune = ignored && input.kind === "directory" && !this.hasNegatedRuleForDescendant(normalized);
		const explanation: IgnoreExplanation = { path: normalized, ignored, prune, trace };
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

	private matchTrace(pathname: string, kind: IgnoreEvaluateInput["kind"], tracked: boolean): IgnoreTraceEntry[] {
		const trace: IgnoreTraceEntry[] = [];
		const sourceTypes = Array.from(new Set(this.ruleSets.map((ruleSet) => ruleSet.sourceType))).sort(
			(a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b],
		);

		for (const sourceType of sourceTypes) {
			const sourceMatch = this.matchSource(sourceType, pathname, kind);
			if (sourceMatch === undefined) continue;
			if (
				sourceType === "gitignore" &&
				this.config.gitignore.trackedFilesBypass &&
				tracked &&
				sourceMatch.state === "ignore"
			) {
				continue;
			}
			trace.push({
				sourceType,
				sourcePath: sourceMatch.rule.sourcePath,
				line: sourceMatch.rule.line,
				pattern: sourceMatch.rule.pattern,
				negated: sourceMatch.rule.negated,
				result: sourceMatch.state,
			});
		}
		return trace;
	}

	private matchSource(sourceType: IgnoreSourceType, pathname: string, kind: IgnoreEvaluateInput["kind"]): SourceMatch | undefined {
		let winner: SourceMatch | undefined;
		const applicable = this.ruleSets
			.filter((ruleSet) => ruleSet.sourceType === sourceType && pathIsInsideBase(pathname, ruleSet.baseDirectory))
			.sort((a, b) => pathDepth(a.baseDirectory) - pathDepth(b.baseDirectory));

		for (const ruleSet of applicable) {
			const relative = toBaseRelative(pathname, ruleSet.baseDirectory);
			if (relative === "") continue;
			const testPath = kind === "directory" ? `${relative}/` : relative;
			let parentExcluded = winner?.state === "ignore" && ruleMatchesDirectoryAncestor(winner.rule, relative, kind);
			for (const compiledRule of ruleSet.rules) {
				if (!compiledRule.matcher.ignores(testPath)) continue;
				if (compiledRule.rule.negated) {
					if (!parentExcluded) winner = { state: "include", rule: compiledRule.rule };
				} else {
					winner = { state: "ignore", rule: compiledRule.rule };
					if (compiledRule.directoryOnly && (kind !== "directory" || relative.includes("/"))) {
						parentExcluded = true;
					}
				}
			}
		}
		return winner;
	}

	private hasNegatedRuleForDescendant(pathname: string): boolean {
		return this.ruleSets.some((ruleSet) => {
			if (!ruleSet.hasNegatedRule) return false;
			return pathIsInsideBase(`${pathname}/child`, ruleSet.baseDirectory);
		});
	}

	private isTracked(pathname: string): boolean {
		if (this.caseInsensitive) {
			const folded = pathname.toLowerCase();
			for (const tracked of this.trackedPaths) {
				if (tracked.toLowerCase() === folded) return true;
			}
			return false;
		}
		return this.trackedPaths.has(pathname);
	}
}

export const defaultIgnoreEngine: IgnoreEngine = new WorkspaceIgnoreEngine();

export async function createIgnoreSnapshot(root: string, config?: PartialIgnoreConfig): Promise<IgnoreSnapshot> {
	return await defaultIgnoreEngine.createSnapshot(root, config);
}

async function discoverRuleFiles(root: string, config: IgnoreConfig): Promise<[RuleFile[], IgnoreDiagnostic[]]> {
	const files: RuleFile[] = [];
	const diagnostics: IgnoreDiagnostic[] = [];

	await collectNestedRuleFiles(root, ".", config, files, diagnostics);
	if (config.gitInfoExclude) {
		await addRuleFile(root, ".git/info/exclude", "git-info-exclude", ".", files);
	}
	return [files.sort(compareRuleFiles), diagnostics];
}

async function collectNestedRuleFiles(
	root: string,
	relativeDirectory: string,
	config: IgnoreConfig,
	files: RuleFile[],
	diagnostics: IgnoreDiagnostic[],
): Promise<void> {
	if (relativeDirectory !== "." && isProtectedWorkspacePath(relativeDirectory)) return;
	const absoluteDirectory = path.join(root, relativeDirectory === "." ? "" : relativeDirectory);
	let entries;
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const childRelative = relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
		if (entry.isSymbolicLink()) continue;
		if (entry.isFile()) {
			if (config.piignore.enabled && entry.name === config.piignore.filename) {
				await addRuleFile(root, childRelative, "piignore", relativeDirectory, files);
			}
			if (config.gitignore.enabled && entry.name === ".gitignore") {
				await addRuleFile(root, childRelative, "gitignore", relativeDirectory, files);
			}
			continue;
		}
		if (!entry.isDirectory()) continue;
		if (isProtectedWorkspacePath(childRelative)) continue;
		if (childRelative !== "." && shouldSkipRuleDiscovery(childRelative)) continue;
		const allowPiNested = config.piignore.nested || relativeDirectory === ".";
		const allowGitNested = config.gitignore.nested || relativeDirectory === ".";
		if (!allowPiNested && !allowGitNested) continue;
		await collectNestedRuleFiles(root, childRelative, config, files, diagnostics);
	}
}

async function addRuleFile(
	root: string,
	relativePath: string,
	sourceType: IgnoreSourceType,
	baseDirectory: string,
	files: RuleFile[],
): Promise<void> {
	const absolutePath = path.join(root, ...relativePath.split("/"));
	try {
		const info = await lstat(absolutePath);
		if (!info.isFile()) return;
		files.push({
			sourceType,
			sourcePath: relativePath,
			absolutePath,
			baseDirectory,
			priority: SOURCE_PRIORITY[sourceType],
			mtimeMs: info.mtimeMs,
			size: info.size,
		});
	} catch {
		return;
	}
}

async function compileRuleSets(
	root: string,
	ruleFiles: RuleFile[],
	config: IgnoreConfig,
	caseInsensitive: boolean,
	discoveryDiagnostics: IgnoreDiagnostic[],
): Promise<{ ruleSets: CompiledRuleSet[]; diagnostics: IgnoreDiagnostic[] }> {
	const diagnostics = [...discoveryDiagnostics];
	const ruleSets: CompiledRuleSet[] = [];

	const builtinRules = BUILTIN_RULES[config.builtinProfile];
	if (builtinRules.length > 0) {
		const ruleSet = compileRuleLines({
			lines: builtinRules,
			sourceType: "builtin",
			baseDirectory: ".",
			caseInsensitive,
			diagnostics,
		});
		if (ruleSet !== undefined) ruleSets.push(ruleSet);
	}

	if (config.sessionRules.length > 0) {
		const ruleSet = compileRuleLines({
			lines: config.sessionRules.map(sessionRuleToPattern),
			sourceType: "session",
			baseDirectory: ".",
			caseInsensitive,
			diagnostics,
		});
		if (ruleSet !== undefined) ruleSets.push(ruleSet);
	}

	for (const file of ruleFiles) {
		const text = await readIgnoreFile(file, diagnostics);
		if (text === undefined) continue;
		const ruleSet = compileRuleLines({
			lines: text.split(/\n/),
			sourceType: file.sourceType,
			sourcePath: file.sourcePath,
			baseDirectory: file.baseDirectory,
			caseInsensitive,
			diagnostics,
		});
		if (ruleSet !== undefined) ruleSets.push(ruleSet);
	}

	return {
		ruleSets: ruleSets.sort((a, b) => a.priority - b.priority || pathDepth(a.baseDirectory) - pathDepth(b.baseDirectory)),
		diagnostics,
	};
}

function compileRuleLines(input: {
	lines: string[];
	sourceType: IgnoreSourceType;
	sourcePath?: string;
	baseDirectory: string;
	caseInsensitive: boolean;
	diagnostics: IgnoreDiagnostic[];
}): CompiledRuleSet | undefined {
	const rules: CompiledRule[] = [];
	let hasAnyRule = false;
	let hasNegatedRule = false;

	for (let index = 0; index < input.lines.length; index += 1) {
		const rawPattern = stripCarriageReturn(index === 0 ? stripBom(input.lines[index] ?? "") : (input.lines[index] ?? ""));
		const parsed = parseRule(rawPattern);
		if (parsed === undefined) continue;

		const ruleMatcher = ignoreFactory({ ignorecase: input.caseInsensitive });
		try {
			ruleMatcher.add(parsed.matchPattern);
		} catch (error) {
			input.diagnostics.push({
				sourcePath: input.sourcePath ?? `<${input.sourceType}>`,
				line: index + 1,
				code: "INVALID_IGNORE_PATTERN",
				message: error instanceof Error ? error.message : "Invalid ignore pattern.",
			});
			continue;
		}

		hasAnyRule = true;
		hasNegatedRule = hasNegatedRule || parsed.negated;
		const rule: MatchedIgnoreRule = {
			sourceType: input.sourceType,
			sourcePath: input.sourcePath,
			line: input.sourcePath === undefined ? undefined : index + 1,
			pattern: rawPattern,
			negated: parsed.negated,
			baseDirectory: input.baseDirectory,
			priority: SOURCE_PRIORITY[input.sourceType],
		};
		rules.push({ rule, matcher: ruleMatcher, directoryOnly: parsed.directoryOnly });
	}

	if (!hasAnyRule) return undefined;
	return {
		sourceType: input.sourceType,
		sourcePath: input.sourcePath,
		baseDirectory: input.baseDirectory,
		priority: SOURCE_PRIORITY[input.sourceType],
		rules,
		hasNegatedRule,
	};
}

async function readIgnoreFile(file: RuleFile, diagnostics: IgnoreDiagnostic[]): Promise<string | undefined> {
	try {
		const bytes = await readFile(file.absolutePath);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		return decoder.decode(bytes).replace(/\r\n/g, "\n");
	} catch (error) {
		diagnostics.push({
			sourcePath: file.sourcePath,
			code: isDecodeError(error) ? "UNSUPPORTED_IGNORE_ENCODING" : "IGNORE_FILE_READ_ERROR",
			message: isDecodeError(error) ? "Ignore file must be valid UTF-8." : "Ignore file could not be read.",
		});
		return undefined;
	}
}

function parseRule(pattern: string): { negated: boolean; matchPattern: string; directoryOnly: boolean } | undefined {
	if (pattern.trim() === "") return undefined;
	if (pattern.startsWith("#")) return undefined;
	if (pattern.startsWith("\\#")) return { negated: false, matchPattern: pattern, directoryOnly: pattern.trimEnd().endsWith("/") };
	if (pattern.startsWith("\\!")) return { negated: false, matchPattern: pattern, directoryOnly: pattern.trimEnd().endsWith("/") };
	const negated = pattern.startsWith("!");
	const matchPattern = negated ? pattern.slice(1) : pattern;
	return { negated, matchPattern, directoryOnly: matchPattern.trimEnd().endsWith("/") };
}

function sessionRuleToPattern(rule: SessionIgnoreRule): string {
	return rule.action === "include" ? `!${rule.pattern}` : rule.pattern;
}

function resolveCaseInsensitive(config: IgnoreConfig, gitIgnoreCase: boolean | undefined): boolean {
	if (config.caseSensitivity === "sensitive") return false;
	if (config.caseSensitivity === "insensitive") return true;
	if (gitIgnoreCase !== undefined) return gitIgnoreCase;
	return process.platform === "win32" || process.platform === "darwin";
}

function buildFingerprint(
	config: IgnoreConfig,
	caseInsensitive: boolean,
	ruleFiles: RuleFile[],
	trackedPaths: ReadonlySet<string>,
	diagnostics: IgnoreDiagnostic[],
): string {
	const filePart = ruleFiles
		.map((file) => `${file.sourceType}:${file.sourcePath}:${file.size}:${file.mtimeMs}`)
		.sort()
		.join("|");
	const trackedPart = Array.from(trackedPaths).sort().join("\0");
	const diagnosticPart = diagnostics.map((diagnostic) => `${diagnostic.sourcePath}:${diagnostic.line}:${diagnostic.code}`).join("|");
	return JSON.stringify({ config, caseInsensitive, filePart, trackedPart, diagnosticPart });
}

function compareRuleFiles(left: RuleFile, right: RuleFile): number {
	return left.priority - right.priority || pathDepth(left.baseDirectory) - pathDepth(right.baseDirectory) || left.sourcePath.localeCompare(right.sourcePath);
}

function shouldSkipRuleDiscovery(relativeDirectory: string): boolean {
	const name = relativeDirectory.split("/").at(-1);
	return name === ".git" || name === "node_modules";
}

function pathDepth(relativePath: string): number {
	return relativePath === "." ? 0 : relativePath.split("/").length;
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

function traceRuleToMatched(trace: IgnoreTraceEntry): MatchedIgnoreRule {
	return {
		sourceType: trace.sourceType,
		sourcePath: trace.sourcePath,
		line: trace.line,
		pattern: trace.pattern,
		negated: trace.negated,
		baseDirectory: ".",
		priority: SOURCE_PRIORITY[trace.sourceType],
	};
}

function ruleMatchesDirectoryAncestor(rule: MatchedIgnoreRule, relative: string, kind: IgnoreEvaluateInput["kind"]): boolean {
	if (!rule.pattern.trimEnd().endsWith("/")) return false;
	if (kind !== "directory") return true;
	return relative.includes("/");
}

function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function stripCarriageReturn(text: string): string {
	return text.endsWith("\r") ? text.slice(0, -1) : text;
}

function isDecodeError(error: unknown): boolean {
	return error instanceof TypeError;
}
