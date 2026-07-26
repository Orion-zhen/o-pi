import picomatch from "picomatch";
import type { AnyPathRef, DirectoryRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.js";
import { compareRankingEvidence, createSourceRankingEvidence, rankingEvidenceSources } from "../shared/ranking/evidence.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { fuseRankedFindSources, selectRankedFindEntries } from "./fusion.js";
import { AbortFindGraph, findGraphCandidates } from "./graph-candidates.js";
import type { FindGraphSource } from "./graph-source.js";
import { createFindEntry, rankGlobEntries, type RankedFindEntry } from "./ranker.js";
import { renderFindResults } from "./renderer.js";
import { AbortFindSuggestionRanking, FindSuggestionRanker } from "./suggestion-pool.js";
import type { FindEntry, FindNearbyResult, FindParams, FindRelatedResult, FindScopeError, FindSuccess } from "./types.js";

interface NormalizedFindParams {
	readonly query: string;
	readonly paths: readonly string[];
}

interface NormalizedFindScope {
	readonly root: DirectoryRef;
	readonly order: number;
}

interface ScopeFindSuccess {
	readonly path: string;
	readonly query: string;
	readonly strategy: "exact" | "glob" | "fuzzy";
	readonly ranked: RankedFindEntry[];
	readonly totalMatches: number;
	readonly scannedEntries: number;
	readonly ignoredCount: number;
	readonly skippedCount: number;
	readonly scanTruncated: boolean;
	readonly related?: FindRelatedResult[];
	readonly nearby?: FindNearbyResult[];
	readonly missingPrefix?: string;
	readonly nearbyDirectory?: string;
}

interface WalkResult {
	readonly entries: FindEntry[];
	readonly scannedEntries: number;
	readonly ignoredCount: number;
	readonly skippedCount: number;
	readonly truncated: boolean;
}

interface GlobFilter {
	readonly base: string;
	matches(candidate: string, kind: FindEntry["kind"]): boolean;
}

export interface FindCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits, "find_output_token_budget" | "find_result_limit" | "find_max_entries_scanned">;
	readonly graph?: FindGraphSource;
}

const RELATED_TRIGGER = 4;
const RELATED_LIMIT = 3;
const NEARBY_LIMIT = 3;

/** Stateful find command. Only the optional suggestion worker pool survives invocations. */
export class FindTool {
	private readonly suggestions = new FindSuggestionRanker();
	private disposed = false;

	async execute(params: FindParams, context: FindCommandContext): Promise<ToolOutcome<FindSuccess>> {
		if (this.disposed) return fail("OPERATION_ABORTED", "find is shut down.");
		const validation = validateFindParams(params);
		if (isFailed(validation)) return validation;
		if (isOperationAborted(context.operation)) return aborted();

		const scopeErrors: FindScopeError[] = [];
		const resolved: NormalizedFindScope[] = [];
		for (const [order, inputPath] of validation.paths.entries()) {
			const root = await resolveSearchRoot(inputPath, context);
			if (isFailed(root)) {
				scopeErrors.push({ path: inputPath, error: root.error });
				continue;
			}
			resolved.push({ root, order });
		}
		const effectiveScopes = resolveEffectiveScopes(resolved, context.filesystem);
		const successes: Array<{ scope: NormalizedFindScope; result: ScopeFindSuccess }> = [];
		for (const scope of effectiveScopes) {
			if (isOperationAborted(context.operation)) return aborted();
			const result = await this.searchOneScope(scope.root, validation.query, context);
			if (isFailed(result)) scopeErrors.push({ path: scope.root.displayPath, error: result.error });
			else successes.push({ scope, result });
		}
		if (successes.length === 0) {
			const first = scopeErrors[0];
			if (first === undefined) return fail("PATH_NOT_FOUND", "No searchable scope was provided.");
			return withScopeErrors({ status: "failed", error: first.error }, validation.paths, scopeErrors);
		}
		return mergeScopeResults(successes, scopeErrors, context.limits);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.suggestions.dispose();
	}

	private async searchOneScope(
		root: DirectoryRef,
		inputQuery: string,
		context: FindCommandContext,
	): Promise<ToolOutcome<ScopeFindSuccess>> {
		try {
			const normalizedQuery = await normalizeFindQuery(root, inputQuery, context);
			if (isFailed(normalizedQuery)) return normalizedQuery;
			const exact = await findExactPath(root, normalizedQuery, context);
			if (isFailed(exact)) return exact;
			if (exact !== undefined) {
				return {
					path: root.displayPath,
					query: exact.query,
					strategy: "exact",
					ranked: exact.entry === undefined ? [] : [{ entry: exact.entry, tier: 0, evidence: createSourceRankingEvidence("path", 1) }],
					totalMatches: exact.entry === undefined ? 0 : 1,
					scannedEntries: 0,
					ignoredCount: 0,
					skippedCount: 0,
					scanTruncated: false,
				};
			}
			const query = normalizedQuery;
			const glob = createQueryGlobFilter(query);
			if (isFailed(glob)) return glob;
			if (glob !== undefined) return await this.runGlobSearch(root, query, glob, context);
			return await this.runRankedSearch(root, query, context);
		} catch (error) {
			if (error instanceof AbortFind || error instanceof AbortFindGraph || error instanceof AbortFindSuggestionRanking) return aborted(root.displayPath);
			return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: root.displayPath });
		}
	}

	private async runGlobSearch(
		searchRoot: DirectoryRef,
		query: string,
		filter: GlobFilter,
		context: FindCommandContext,
	): Promise<ToolOutcome<ScopeFindSuccess>> {
		const walkRoot = await resolveGlobRoot(searchRoot, filter.base, context);
		if (isFailed(walkRoot)) {
			return {
				path: searchRoot.displayPath,
				query,
				strategy: "glob",
				ranked: [],
				totalMatches: 0,
				scannedEntries: 0,
				ignoredCount: 0,
				skippedCount: 0,
				scanTruncated: false,
				missingPrefix: filter.base,
				...(typeof walkRoot.error.details?.["nearbyDirectory"] === "string"
					? { nearbyDirectory: walkRoot.error.details["nearbyDirectory"] }
					: {}),
			};
		}
		const walked = await walkFindEntries(walkRoot, searchRoot, context, filter.matches);
		if (isFailed(walked)) return walked;
		const ranked = rankGlobEntries(walked.entries);
		return {
			path: searchRoot.displayPath,
			query,
			strategy: "glob",
			ranked,
			totalMatches: ranked.length,
			scannedEntries: walked.scannedEntries,
			ignoredCount: walked.ignoredCount,
			skippedCount: walked.skippedCount,
			scanTruncated: walked.truncated,
		};
	}

	private async runRankedSearch(
		searchRoot: DirectoryRef,
		query: string,
		context: FindCommandContext,
	): Promise<ToolOutcome<ScopeFindSuccess>> {
		const [walked, graph] = await Promise.all([
			walkFindEntries(searchRoot, searchRoot, context),
			findGraphCandidates(searchRoot, query, {
				filesystem: context.filesystem,
				operation: context.operation,
				resultLimit: context.limits.find_result_limit,
				...(context.graph === undefined ? {} : { graph: context.graph }),
			}),
		]);
		if (isFailed(walked)) return walked;
		const ranked = await this.suggestions.rank(walked.entries, query, searchRoot.displayPath, context.operation.signal);
		const merged = fuseRankedFindSources(ranked.matches, graph.matching);
		const nearby = merged.length === 0 ? findNearbyResults(ranked.suggestions) : [];
		return {
			path: searchRoot.displayPath,
			query,
			strategy: "fuzzy",
			ranked: merged,
			totalMatches: merged.length,
			scannedEntries: walked.scannedEntries,
			ignoredCount: walked.ignoredCount,
			skippedCount: walked.skippedCount,
			scanTruncated: walked.truncated,
			...(merged.length < RELATED_TRIGGER && graph.related.length > 0 ? { related: graph.related } : {}),
			...(nearby.length > 0 ? { nearby } : {}),
		};
	}
}

function validateFindParams(params: FindParams): ToolOutcome<NormalizedFindParams> {
	if (typeof params.query !== "string" || params.query.length === 0) return fail("INVALID_PATH", "query must not be empty.");
	if (params.query.includes("\0")) return fail("INVALID_PATH", "query must not contain NUL bytes.", { path: params.query });
	const rawPaths = params.path === undefined ? ["."] : params.path;
	if (!Array.isArray(rawPaths) || rawPaths.length === 0) return fail("INVALID_PATH", "path must contain at least one scope.");
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const searchPath of rawPaths) {
		if (typeof searchPath !== "string" || searchPath.length === 0) return fail("INVALID_PATH", "path entries must be non-empty strings.");
		if (searchPath.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: searchPath });
		if (!seen.has(searchPath)) {
			seen.add(searchPath);
			paths.push(searchPath);
		}
	}
	return { query: params.query, paths };
}

async function resolveSearchRoot(input: string, context: FindCommandContext): Promise<ToolOutcome<DirectoryRef>> {
	const resolved = await context.filesystem.paths.resolveExisting(
		input,
		{ expected: "directory", followFinalSymlink: true },
		context.operation,
	);
	if (!resolved.ok) {
		const message = resolved.error.code === "not-found" ? "Directory does not exist."
			: resolved.error.code === "not-directory" ? "Path is not a directory."
				: undefined;
		return mapFsError(resolved.error, message === undefined ? {} : { message });
	}
	if (resolved.value.kind !== "directory") return fail("NOT_A_DIRECTORY", "Path is not a directory.", { path: resolved.value.displayPath });
	return resolved.value;
}

function resolveEffectiveScopes(scopes: readonly NormalizedFindScope[], filesystem: WorkspaceFileSystem): NormalizedFindScope[] {
	return scopes.filter((scope, index) => !scopes.some((parent, parentIndex) => {
		if (parentIndex === index || !filesystem.paths.isWithin(parent.root, scope.root)) return false;
		const sameDirectory = filesystem.paths.isWithin(scope.root, parent.root);
		return !sameDirectory || parentIndex < index;
	}));
}

async function findExactPath(
	root: DirectoryRef,
	inputQuery: string,
	context: FindCommandContext,
): Promise<ToolOutcome<{ readonly query: string; readonly entry?: FindEntry } | undefined>> {
	const query = joinDisplayPath(root.displayPath, inputQuery);
	const resolved = await context.filesystem.paths.resolveExisting(
		query,
		{ expected: "any", followFinalSymlink: false },
		context.operation,
	);
	if (!resolved.ok) {
		if (resolved.error.code === "not-found") return undefined;
		if (resolved.error.code === "blocked") return { query: inputQuery };
		return mapFsError(resolved.error, { message: "Path cannot be accessed." });
	}
	if (!context.filesystem.paths.isWithin(root, resolved.value)) {
		return fail("INVALID_PATH", "query must not escape path.", { path: inputQuery });
	}
	if (resolved.value.kind !== "file" && resolved.value.kind !== "directory") return { query: inputQuery };
	return { query: inputQuery, entry: createFindEntry(resolved.value.displayPath, resolved.value.kind) };
}

async function normalizeFindQuery(root: DirectoryRef, input: string, context: FindCommandContext): Promise<ToolOutcome<string>> {
	if (!isAbsolutePath(input)) {
		const query = normalizeLogical(input);
		if (query.split("/").some((part) => part === "..")) return fail("INVALID_PATH", "query must not escape path.", { path: input });
		return query;
	}
	const target = await context.filesystem.paths.resolveTarget(input, { followExistingSymlink: false }, context.operation);
	if (!target.ok) {
		if (target.error.code === "blocked" && target.error.path !== undefined) {
			const blockedQuery = relativeDisplayPath(root, target.error.path);
			if (blockedQuery !== undefined) return blockedQuery;
		}
		return mapFsError(target.error);
	}
	if (!context.filesystem.paths.isWithin(root, target.value)) return fail("INVALID_PATH", "query must not escape path.", { path: input });
	const query = relativeRefPath(root, target.value);
	return query ?? fail("INVALID_PATH", "query must be relative to path.", { path: input });
}

async function resolveGlobRoot(
	searchRoot: DirectoryRef,
	prefix: string,
	context: FindCommandContext,
): Promise<ToolOutcome<DirectoryRef>> {
	if (prefix === ".") return searchRoot;
	let current = searchRoot;
	for (const segment of prefix.split("/")) {
		const resolved = await context.filesystem.paths.resolveExisting(
			joinDisplayPath(current.displayPath, segment),
			{ expected: "directory", followFinalSymlink: false },
			context.operation,
		);
		if (!resolved.ok || resolved.value.kind !== "directory") {
			const nearby = await nearbyDirectory(current, segment, context);
			return fail("PATH_NOT_FOUND", "Glob static prefix does not exist.", {
				details: { missingPrefix: joinDisplayPath(current.displayPath, segment), ...(nearby === undefined ? {} : { nearbyDirectory: nearby }) },
			});
		}
		current = resolved.value;
	}
	return current;
}

async function nearbyDirectory(root: DirectoryRef, name: string, context: FindCommandContext): Promise<string | undefined> {
	const suggested = await context.filesystem.catalog.suggest(
		root,
		name,
		{ limit: 1, maxEntries: 100, kinds: ["directory"] },
		context.operation,
	);
	return suggested.ok ? suggested.value[0]?.ref.displayPath : undefined;
}

async function walkFindEntries(
	walkRoot: DirectoryRef,
	searchRoot: DirectoryRef,
	context: FindCommandContext,
	matches?: (candidate: string, kind: FindEntry["kind"]) => boolean,
): Promise<ToolOutcome<WalkResult>> {
	const opened = await context.filesystem.traversal.walk(walkRoot, {
		intent: "search",
		explicitRoot: true,
		maxEntries: context.limits.find_max_entries_scanned,
	}, context.operation);
	if (!opened.ok) return mapFsError(opened.error, { message: "Directory cannot be searched." });
	const entries: FindEntry[] = [];
	let scannedEntries = 0;
	let ignoredCount = 0;
	let skippedCount = 0;
	let truncated = false;
	try {
		for await (const event of opened.value) {
			if (event.type === "entry") {
				scannedEntries += 1;
				if (event.ref.kind !== "file" && event.ref.kind !== "directory") continue;
				const relative = relativeRefPath(searchRoot, event.ref);
				if (relative !== undefined && (matches === undefined || matches(relative, event.ref.kind))) {
					entries.push(createFindEntry(event.ref.displayPath, event.ref.kind));
				}
				continue;
			}
			if (event.type === "skip") {
				if (event.reason === "entry-limit") {
					truncated = true;
					continue;
				}
				if (event.reason === "blocked") continue;
				scannedEntries += 1;
				if (event.reason === "ignored") ignoredCount += 1;
				continue;
			}
			if (event.error.code === "aborted") throw new AbortFind();
			skippedCount += event.error.code === "access-denied" ? 1 : 0;
		}
	} finally {
		await opened.value.close();
	}
	return { entries, scannedEntries, ignoredCount, skippedCount, truncated };
}

function mergeScopeResults(
	successes: Array<{ scope: NormalizedFindScope; result: ScopeFindSuccess }>,
	scopeErrors: FindScopeError[],
	limits: FindCommandContext["limits"],
): FindSuccess {
	const candidates = new Map<string, RankedFindEntry>();
	for (const { scope, result } of successes) {
		for (const candidate of result.ranked) {
			const scoped = { ...candidate, scopeOrder: scope.order };
			const existing = candidates.get(candidate.entry.path);
			if (existing === undefined) candidates.set(candidate.entry.path, scoped);
			else {
				const merged = fuseRankedFindSources([existing], [scoped])[0];
				if (merged !== undefined) candidates.set(candidate.entry.path, { ...merged, scopeOrder: Math.min(existing.scopeOrder ?? scope.order, scope.order) });
			}
		}
	}
	const ranked = [...candidates.values()].sort(compareFindCandidates);
	const related = ranked.length < RELATED_TRIGGER ? mergeRelated(successes.flatMap(({ result }) => result.related ?? [])) : [];
	const nearby = ranked.length === 0 ? mergeNearby(successes.flatMap(({ result }) => result.nearby ?? [])) : [];
	const strategy = successes.some(({ result }) => result.strategy === "fuzzy") ? "fuzzy"
		: successes.some(({ result }) => result.strategy === "glob") ? "glob" : "exact";
	const paths = successes.map(({ scope }) => scope.root.displayPath);
	const missing = successes.map(({ result }) => result).find((result) => result.missingPrefix !== undefined);
	const selected = selectRankedFindEntries(ranked, limits.find_result_limit);
	const matches = selected.map(({ entry }) => ({ path: entry.path, kind: entry.kind }));
	const candidateSources = Object.fromEntries(selected.map((item) => [item.entry.path, rankingEvidenceSources(item.evidence)]));
	return renderFindResults({
		query: successes[0]?.result.query ?? "",
		path: paths[0] ?? ".",
		paths,
		...(scopeErrors.length === 0 ? {} : { scopeErrors }),
		strategy,
		totalMatches: ranked.length,
		scannedEntries: successes.reduce((sum, item) => sum + item.result.scannedEntries, 0),
		matches,
		candidateSources,
		ignoredCount: successes.reduce((sum, item) => sum + item.result.ignoredCount, 0),
		skippedCount: successes.reduce((sum, item) => sum + item.result.skippedCount, 0),
		scanTruncated: successes.some(({ result }) => result.scanTruncated),
		resultLimited: selected.length < ranked.length,
		outputTokenBudget: limits.find_output_token_budget,
		...(related.length === 0 ? {} : { related }),
		...(nearby.length === 0 ? {} : { nearby }),
		...(missing?.missingPrefix === undefined ? {} : { missingPrefix: missing.missingPrefix }),
		...(missing?.nearbyDirectory === undefined ? {} : { nearbyDirectory: missing.nearbyDirectory }),
	});
}

function compareFindCandidates(left: RankedFindEntry, right: RankedFindEntry): number {
	return left.tier - right.tier
		|| compareRankingEvidence(left.evidence, right.evidence)
		|| (left.scopeOrder ?? Number.MAX_SAFE_INTEGER) - (right.scopeOrder ?? Number.MAX_SAFE_INTEGER)
		|| compareStableString(left.entry.path, right.entry.path);
}

function mergeRelated(results: readonly FindRelatedResult[]): FindRelatedResult[] {
	const merged = new Map<string, FindRelatedResult>();
	for (const result of results) {
		const existing = merged.get(result.path);
		if (existing === undefined) merged.set(result.path, { ...result, relations: [...result.relations] });
		else for (const relation of result.relations) if (!existing.relations.includes(relation)) existing.relations.push(relation);
	}
	return [...merged.values()].slice(0, RELATED_LIMIT);
}

function mergeNearby(results: readonly FindNearbyResult[]): FindNearbyResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		if (seen.has(result.path)) return false;
		seen.add(result.path);
		return true;
	}).slice(0, NEARBY_LIMIT);
}

function findNearbyResults(suggestions: readonly RankedFindEntry[]): FindNearbyResult[] {
	const seen = new Set<string>();
	const results: FindNearbyResult[] = [];
	for (const { entry } of suggestions) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		results.push({ path: entry.path, kind: entry.kind, reason: "name similarity" });
		if (results.length >= NEARBY_LIMIT) break;
	}
	return results;
}

function withScopeErrors(result: FailedResult, paths: readonly string[], scopeErrors: FindScopeError[]): FailedResult {
	return { ...result, error: { ...result.error, details: { ...(result.error.details ?? {}), paths: [...paths], scope_errors: scopeErrors } } };
}

function createQueryGlobFilter(query: string): ToolOutcome<GlobFilter | undefined> {
	try {
		const scanned = picomatch.scan(query, { tokens: true });
		if (!scanned.isGlob) return undefined;
		const basenameOnly = !query.includes("/");
		const base = normalizeLogical(basenameOnly ? "." : (scanned.base.length === 0 ? "." : scanned.base));
		const matchPattern = picomatch(query, { dot: true, nonegate: true });
		return {
			base,
			matches(candidate, kind) {
				const target = basenameOnly ? basename(candidate) : candidate;
				return matchPattern(target) || (kind === "directory" && matchPattern(`${target}/`));
			},
		};
	} catch (error) {
		return fail("INVALID_PATH", "query glob is not valid.", { details: { error: error instanceof Error ? error.message : String(error) } });
	}
}

function relativeRefPath(root: DirectoryRef, candidate: AnyPathRef): string | undefined {
	if (root.id === candidate.id) return ".";
	if (root.workspacePath !== undefined && candidate.workspacePath !== undefined) {
		return relativeLogicalPath(root.workspacePath, candidate.workspacePath);
	}
	return relativeLogicalPath(root.displayPath, candidate.displayPath);
}

function relativeDisplayPath(root: DirectoryRef, candidateDisplayPath: string): string | undefined {
	if (root.workspacePath !== undefined && !isAbsolutePath(candidateDisplayPath)) {
		return relativeLogicalPath(root.workspacePath, candidateDisplayPath);
	}
	return relativeLogicalPath(root.displayPath, candidateDisplayPath);
}

function relativeLogicalPath(rootPath: string, candidatePath: string): string | undefined {
	const normalizedRoot = normalizeForComparison(rootPath);
	const normalizedCandidate = normalizeForComparison(candidatePath);
	if (normalizedRoot === normalizedCandidate) return ".";
	if (normalizedRoot === ".") return isAbsolutePath(candidatePath) ? undefined : normalizedCandidate;
	const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
	return normalizedCandidate.startsWith(prefix) ? normalizedCandidate.slice(prefix.length) : undefined;
}

function joinDisplayPath(parent: string, child: string): string {
	if (isAbsolutePath(child)) return child;
	if (parent === ".") return normalizeLogical(child);
	const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
	return parent.endsWith(separator) ? `${parent}${child}` : `${parent}${separator}${child}`;
}

function normalizeLogical(value: string): string {
	return value.replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/").replace(/\/$/u, "") || ".";
}

function normalizeForComparison(value: string): string {
	return value.replace(/\\/gu, "/").replace(/\/$/u, "");
}

function basename(value: string): string {
	const normalized = normalizeForComparison(value);
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(value);
}

function isOperationAborted(operation: FsOperationContext): boolean {
	return operation.signal?.aborted === true;
}

function aborted(path?: string): FailedResult {
	return fail("OPERATION_ABORTED", "find was aborted.", path === undefined ? {} : { path });
}

class AbortFind extends Error {}

function compareStableString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
