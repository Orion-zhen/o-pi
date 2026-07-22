import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import pLimit from "p-limit";

import { ignoreConfigFromFileTools, isBlockedPath, isIgnoredPath, loadFileToolsConfig, toolPathIdentity, type FileToolsConfig } from "../config.js";
import { fail, isAccessDenied, isFailed, protectedPathFailure } from "../core/errors.js";
import { createFindEntry, rankGlobEntries, type RankedFindEntry } from "../find/ranker.js";
import { AbortFindSuggestionRanking, rankFindEntriesForSearch } from "../find/suggestion-pool.js";
import { fuseRankedFindSources, selectRankedFindEntries } from "../find/fusion.js";
import { renderFindResults } from "../find/renderer.js";
import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE, rankingEvidenceSources } from "../ranking-evidence.js";
import { defaultIgnoreEngine } from "../ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "../ignore/ignore-types.js";
import { guardExistingPath, PathGuardBlockedError } from "../../safety/path-guard.js";
import { normalizeToolPath, resolveWorkspaceRoot } from "../core/path-resolver.js";
import type { FindEntry, FindMatch, FindNearbyResult, FindParams, FindSuccess, RepoMapRelatedResult, ToolOutcome } from "../types.js";
import type { RepoMapFileToolQuery } from "../../repo-map/file-tool-query.js";
import type { RepoMapQueryCandidate } from "../../repo-map/query.js";
import { isRepoMapMainCandidate, isRepoMapNavigationCandidate, repoMapEvidenceTier, repoMapNavigationRelation, repoMapRankingEvidence } from "../repo-map-ranking.js";

interface NormalizedFindParams {
	query: string;
	path: string;
}

interface SearchRoot {
	relativePath: string;
	absolutePath: string;
	workspacePath?: string;
}

type ExactPathResult = FindEntry | "excluded" | undefined;

interface WalkState {
	workspaceRoot: string;
	searchRoot: SearchRoot;
	config: FileToolsConfig;
	ignoreSnapshot: IgnoreSnapshot;
	ignoreBypass: boolean;
	signal?: AbortSignal;
	entries: FindEntry[];
	scannedEntries: number;
	ignoredCount: number;
	skippedCount: number;
	truncated: boolean;
	maxEntriesScanned: number;
	matchesGlob?: (candidate: string, kind: FindEntry["kind"]) => boolean;
}

export interface FindRuntime {
	repoMap?: RepoMapFileToolQuery;
}

interface RepoMapFindInput {
	workspaceRoot: string;
	searchRoot: SearchRoot;
	query: string;
	config: FileToolsConfig;
	ignoreSnapshot: IgnoreSnapshot;
	ignoreBypass: boolean;
	signal: AbortSignal | undefined;
}

type RepoMapRankedFindEntry = RankedFindEntry;

interface ValidatedRepoMapFindEntry extends RepoMapRankedFindEntry {
	candidate: RepoMapQueryCandidate;
	matchesQuery: boolean;
	navigation: boolean;
	repoMapOrder: number;
	relation?: string;
}

interface SelectedRepoMapCandidate {
	candidate: RepoMapQueryCandidate;
	order: number;
}

interface RepoMapFindCandidates {
	matching: RepoMapRankedFindEntry[];
	related: RepoMapRelatedResult[];
}

const REPO_MAP_VALIDATION_CONCURRENCY = 8;
const FIND_RELATED_TRIGGER = 4;
const FIND_RELATED_LIMIT = 3;
const FIND_NEARBY_LIMIT = 3;

/** find 自动路由精确路径、glob 和名称/路径/语义查询。 */
export async function findWorkspaceFiles(
	cwd: string,
	params: FindParams,
	signal?: AbortSignal,
	runtime: FindRuntime = {},
): Promise<ToolOutcome<FindSuccess>> {
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const validation = validateFindParams(workspaceRoot, params);
	if (isFailed(validation)) return validation;
	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const searchRoot = await resolveWorkspaceSearchRoot(workspaceRoot, validation.path, config);
	if (isFailed(searchRoot)) return searchRoot;
	const normalizedQuery = normalizeFindQuery(searchRoot, validation.query);
	if (isFailed(normalizedQuery)) return normalizedQuery;
	const normalized = { ...validation, query: normalizedQuery };
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));

	try {
		assertNotAborted(signal);
		const exact = await findExactPath(searchRoot, normalized.query, config);
		if (isFailed(exact)) return exact;
		if (exact === "excluded") {
			return renderSuccess({
				query: normalized.query,
				path: searchRoot.relativePath,
				strategy: "exact",
				ranked: [],
				totalMatches: 0,
				scannedEntries: 0,
				ignoredCount: 0,
				skippedCount: 0,
				scanTruncated: false,
				config,
			});
		}
		if (exact !== undefined) {
			return renderSuccess({
				query: normalized.query,
				path: searchRoot.relativePath,
				strategy: "exact",
				ranked: [{
					entry: exact,
					tier: 0,
					evidence: createSourceRankingEvidence("path", 1),
				}],
				totalMatches: 1,
				scannedEntries: 0,
				ignoredCount: 0,
				skippedCount: 0,
				scanTruncated: false,
				config,
			});
		}

		const glob = createQueryGlobFilter(normalized.query);
		if (isFailed(glob)) return glob;
		if (glob !== undefined) return await runGlobSearch(workspaceRoot, searchRoot, normalized, config, ignoreSnapshot, signal, glob);
		return await runRankedSearch(workspaceRoot, searchRoot, normalized, config, ignoreSnapshot, signal, runtime);
	} catch (error) {
		if (error instanceof AbortFind || error instanceof AbortFindSuggestionRanking) return fail("OPERATION_ABORTED", "find was aborted.", { path: searchRoot.relativePath });
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Directory cannot be searched.", { path: searchRoot.relativePath });
		return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: searchRoot.relativePath });
	}
}

function validateFindParams(workspaceRoot: string, params: FindParams): ToolOutcome<NormalizedFindParams> {
	if (typeof params.query !== "string" || params.query.length === 0) return fail("INVALID_PATH", "query must not be empty.");
	if (params.query.includes("\0")) return fail("INVALID_PATH", "query must not contain NUL bytes.", { path: params.query });

	const searchPath = params.path ?? ".";
	if (typeof searchPath !== "string" || searchPath.length === 0) return fail("INVALID_PATH", "path must not be empty.", { path: searchPath });
	if (searchPath.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: searchPath });
	const normalizedSearchPath = normalizeInputPath(workspaceRoot, searchPath);
	if (isFailed(normalizedSearchPath)) return normalizedSearchPath;
	return {
		query: params.query,
		path: normalizedSearchPath.path,
	};
}

function normalizeInputPath(workspaceRoot: string, inputPath: string): ToolOutcome<{ path: string }> {
	const lexical = normalizeToolPath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	return { path: normalizeRelative(lexical.relativePath) };
}

function normalizeFindQuery(searchRoot: SearchRoot, inputQuery: string): ToolOutcome<string> {
	if (path.isAbsolute(inputQuery)) {
		const lexical = normalizeToolPath(searchRoot.absolutePath, inputQuery);
		if (isFailed(lexical)) return lexical;
		const query = normalizeRelative(path.relative(searchRoot.absolutePath, lexical.absolutePath));
		if (query.split("/").some((part) => part === "..")) return fail("INVALID_PATH", "query must not escape path.", { path: inputQuery });
		return query;
	}
	const query = normalizeRelative(inputQuery);
	if (path.isAbsolute(query) || /^[A-Za-z]:\//u.test(query)) return fail("INVALID_PATH", "query must be relative to path.", { path: inputQuery });
	if (query.split("/").some((part) => part === "..")) return fail("INVALID_PATH", "query must not escape path.", { path: inputQuery });
	return query;
}

async function resolveWorkspaceSearchRoot(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig,
): Promise<ToolOutcome<SearchRoot>> {
	const lexical = normalizeToolPath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	let guardedRealPath: string | undefined;
	try {
		const guarded = await guardExistingPath(inputPath, { cwd: workspaceRoot, blocked_path: config.blocked_path });
		guardedRealPath = guarded.real_path;
	} catch (error) {
		if (error instanceof PathGuardBlockedError) return protectedPathFailure(lexical.relativePath, error.block);
		throw error;
	}

	try {
		const searchPath = guardedRealPath ?? lexical.absolutePath;
		const info = await stat(searchPath);
		if (!info.isDirectory()) return fail("NOT_A_DIRECTORY", "Path is not a directory.", { path: lexical.relativePath });
		return {
			relativePath: lexical.relativePath,
			absolutePath: searchPath,
			...(lexical.workspacePath !== undefined ? { workspacePath: lexical.workspacePath } : {}),
		};
	} catch (error) {
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Directory cannot be searched.", { path: lexical.relativePath });
		return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: lexical.relativePath });
	}
}

async function findExactPath(
	searchRoot: SearchRoot,
	query: string,
	config: FileToolsConfig,
): Promise<ToolOutcome<ExactPathResult>> {
	const absolutePath = path.resolve(searchRoot.absolutePath, query);
	const displayPath = childDisplayPath(searchRoot.relativePath, query);
	const workspacePath = childWorkspacePath(searchRoot.workspacePath, query);
	const identity = toolPathIdentity(displayPath, absolutePath, workspacePath);
	if (isBlockedPath(config, identity)) return "excluded";
	let info;
	try {
		info = await lstat(absolutePath);
	} catch (error) {
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Path cannot be accessed.", { path: displayPath });
		return undefined;
	}
	if (info.isSymbolicLink()) return "excluded";
	const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
	if (kind === undefined) return undefined;
	return createFindEntry(displayPath, kind);
}

interface GlobFilter {
	base: string;
	matches(candidate: string, kind: FindEntry["kind"]): boolean;
}

async function runGlobSearch(
	workspaceRoot: string,
	searchRoot: SearchRoot,
	params: NormalizedFindParams,
	config: FileToolsConfig,
	ignoreSnapshot: IgnoreSnapshot,
	signal: AbortSignal | undefined,
	filter: GlobFilter,
): Promise<ToolOutcome<FindSuccess>> {
	const walkRoot = await childSearchRoot(searchRoot, filter.base, config);
	if (isFailed(walkRoot)) {
		return renderMissingPrefix(params, searchRoot, config, filter.base, walkRoot.error.details?.["nearbyDirectory"]);
	}
	const state = createWalkState(
		workspaceRoot,
		searchRoot,
		config,
		ignoreSnapshot,
		isDirectoryIgnored(walkRoot, config, ignoreSnapshot),
		signal,
		filter.matches,
	);
	await walkDirectory(
		state,
		walkRoot.absolutePath,
		walkRoot.relativePath,
		walkRoot.workspacePath,
		relativeToSearchRoot(searchRoot.relativePath, walkRoot.relativePath),
	);
	const ranked = rankGlobEntries(state.entries);
	return renderSuccess({
		query: params.query,
		path: searchRoot.relativePath,
		strategy: "glob",
		ranked,
		totalMatches: ranked.length,
		scannedEntries: state.scannedEntries,
		ignoredCount: state.ignoredCount,
		skippedCount: state.skippedCount,
		scanTruncated: state.truncated,
		config,
	});
}

async function runRankedSearch(
	workspaceRoot: string,
	searchRoot: SearchRoot,
	params: NormalizedFindParams,
	config: FileToolsConfig,
	ignoreSnapshot: IgnoreSnapshot,
	signal: AbortSignal | undefined,
	runtime: FindRuntime,
): Promise<ToolOutcome<FindSuccess>> {
	const state = createWalkState(
		workspaceRoot,
		searchRoot,
		config,
		ignoreSnapshot,
		isDirectoryIgnored(searchRoot, config, ignoreSnapshot),
		signal,
	);
	const [, repoMapCandidates] = await Promise.all([
		walkDirectory(
			state,
			searchRoot.absolutePath,
			searchRoot.relativePath,
			searchRoot.workspacePath,
			".",
		),
		safeRepoMapFindCandidates(runtime.repoMap, {
				workspaceRoot,
				searchRoot,
				query: params.query,
				config,
				ignoreSnapshot,
				ignoreBypass: state.ignoreBypass,
				signal,
			}),
	]);
	const ranked = await rankFindEntriesForSearch(state.entries, params.query, searchRoot.relativePath, signal);
	const merged = fuseRankedFindSources(ranked.matches, repoMapCandidates.matching);
	const nearby = merged.length === 0 ? findNearbyResults(ranked.suggestions) : [];
	return renderSuccess({
		query: params.query,
		path: searchRoot.relativePath,
		strategy: "fuzzy",
		ranked: merged,
		totalMatches: merged.length,
		scannedEntries: state.scannedEntries,
		ignoredCount: state.ignoredCount,
		skippedCount: state.skippedCount,
		scanTruncated: state.truncated,
		config,
		...(merged.length < FIND_RELATED_TRIGGER && repoMapCandidates.related.length > 0 ? { related: repoMapCandidates.related } : {}),
		...(nearby.length > 0 ? { nearby } : {}),
	});
}

async function safeRepoMapFindCandidates(
	queryLayer: RepoMapFileToolQuery | undefined,
	input: RepoMapFindInput,
): Promise<RepoMapFindCandidates> {
	if (queryLayer === undefined) return emptyRepoMapFindCandidates();
	try {
		const queried = await queryLayer.query({
			requestedPath: input.searchRoot.absolutePath,
			query: input.query,
			limit: Math.max(24, input.config.limits.find_result_limit * 4),
		});
		if (queried === undefined) return emptyRepoMapFindCandidates();
		const selected = selectRepoMapFindCandidates(queried.candidates);
		const hashes = new Map<string, Promise<string | undefined>>();
		const limit = pLimit(REPO_MAP_VALIDATION_CONCURRENCY);
		const candidates = await Promise.all(selected.map((candidate) => limit(async () => {
			assertNotAborted(input.signal);
			return await validateRepoMapFindCandidate(candidate, queried.root, input, hashes);
		})));
		const validated = candidates.filter((candidate): candidate is ValidatedRepoMapFindEntry => candidate !== undefined);
		return partitionRepoMapFindCandidates(validated);
	} catch (error) {
		if (error instanceof AbortFind) throw error;
		return emptyRepoMapFindCandidates();
	}
}

async function validateRepoMapFindCandidate(
	selected: SelectedRepoMapCandidate,
	mapRoot: string,
	input: RepoMapFindInput,
	hashes: Map<string, Promise<string | undefined>>,
): Promise<ValidatedRepoMapFindEntry | undefined> {
	const { candidate } = selected;
	const absolutePath = path.resolve(mapRoot, candidate.path);
	const searchRelative = relativeInside(input.searchRoot.absolutePath, absolutePath);
	if (searchRelative === undefined || searchRelative === ".") return undefined;
	const workspaceRelative = relativeInside(input.workspaceRoot, absolutePath);
	if (workspaceRelative === undefined) return undefined;
	const displayPath = childDisplayPath(input.searchRoot.relativePath, searchRelative);
	const identity = toolPathIdentity(displayPath, absolutePath, workspaceRelative);
	if (isBlockedPath(input.config, identity)) return undefined;
	const matchesQuery = isRepoMapMainCandidate(candidate, input.query);
	if (!input.ignoreBypass) {
		if (isIgnoredPath(input.config, identity)) return undefined;
		if (input.ignoreSnapshot.evaluate({ path: workspaceRelative, kind: "file", intent: "search" }).ignored) return undefined;
	}
	let info;
	try {
		info = await lstat(absolutePath);
	} catch {
		return undefined;
	}
	if (!info.isFile() || info.isSymbolicLink()) return undefined;
	if (!await matchesCurrentHash(absolutePath, candidate.contentHash, input.signal, hashes)) return undefined;
	for (const related of candidate.relatedEdges.flatMap((edge) => edge.relatedFiles)) {
		const relatedAbsolutePath = path.resolve(mapRoot, related.path);
		if (relativeInside(input.searchRoot.absolutePath, relatedAbsolutePath) === undefined) return undefined;
		if (!await matchesCurrentHash(relatedAbsolutePath, related.contentHash, input.signal, hashes)) return undefined;
	}
	const relation = repoMapNavigationRelation(candidate);
	const baseTier = repoMapEvidenceTier(candidate);
	const tier = !hasFindTestIntent(input.query) && !/[A-Z]/u.test(input.query) && isTestLikeRepoMapCandidate(candidate)
		? Math.max(5, baseTier)
		: baseTier;
	return {
		candidate,
		entry: createFindEntry(displayPath, "file"),
		tier,
		evidence: EMPTY_RANKING_EVIDENCE,
		matchesQuery,
		navigation: isRepoMapNavigationCandidate(candidate),
		repoMapOrder: selected.order,
		...(relation !== undefined ? { relation } : {}),
	};
}

function hasFindTestIntent(query: string): boolean {
	return /(?:^|[^a-z0-9])(?:tests?|specs?|fixtures?|mocks?)(?:$|[^a-z0-9])/iu.test(query);
}

function isTestLikeRepoMapCandidate(candidate: RepoMapQueryCandidate): boolean {
	return candidate.reasons.some((reason) => reason === "test" || reason === "mock" || reason === "fixture" || reason === "snapshot" || reason === "test config")
		|| /(?:^|\/)(?:tests?|fixtures?|mocks?)(?:\/|$)|(?:\.|-)(?:test|spec)\.[^/]+$/iu.test(candidate.path);
}

function selectRepoMapFindCandidates(candidates: RepoMapQueryCandidate[]): SelectedRepoMapCandidate[] {
	return candidates.map((candidate, order) => ({
		candidate,
		order,
	}));
}

function partitionRepoMapFindCandidates(candidates: ValidatedRepoMapFindEntry[]): RepoMapFindCandidates {
	const matching = candidates.filter((candidate) => candidate.matchesQuery);
	for (const [index, candidate] of matching.entries()) {
		candidate.evidence = repoMapRankingEvidence(candidate.candidate, index + 1, true);
	}
	const relatedByPath = new Map<string, { result: RepoMapRelatedResult; order: number }>();
	for (const candidate of candidates) {
		if (candidate.matchesQuery || !candidate.navigation || candidate.relation === undefined) continue;
		const existing = relatedByPath.get(candidate.entry.path);
		if (existing === undefined) {
			relatedByPath.set(candidate.entry.path, {
				result: {
					path: candidate.entry.path,
					kind: "file",
					source: "repo-map",
					relations: [candidate.relation],
					query_match: "not_guaranteed",
				},
				order: candidate.repoMapOrder,
			});
			continue;
		}
		if (existing.result.relations.length < 2 && !existing.result.relations.includes(candidate.relation)) existing.result.relations.push(candidate.relation);
		existing.order = Math.min(existing.order, candidate.repoMapOrder);
	}
	const related = [...relatedByPath.values()]
		.sort((left, right) => left.order - right.order || compareStableString(left.result.path, right.result.path))
		.slice(0, FIND_RELATED_LIMIT)
		.map((item) => item.result);
	return { matching, related };
}

function emptyRepoMapFindCandidates(): RepoMapFindCandidates {
	return { matching: [], related: [] };
}

async function matchesCurrentHash(
	absolutePath: string,
	expected: string | undefined,
	signal: AbortSignal | undefined,
	hashes: Map<string, Promise<string | undefined>>,
): Promise<boolean> {
	if (expected === undefined) return false;
	let pending = hashes.get(absolutePath);
	if (pending === undefined) {
		pending = currentHash(absolutePath, signal);
		hashes.set(absolutePath, pending);
	}
	return await pending === expected;
}

async function currentHash(absolutePath: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		const bytes = signal === undefined ? await readFile(absolutePath) : await readFile(absolutePath, { signal });
		return createHash("sha256").update(bytes).digest("hex");
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw new AbortFind();
		return undefined;
	}
}

function relativeInside(root: string, target: string): string | undefined {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return normalizeRelative(relative);
}

function createWalkState(
	workspaceRoot: string,
	searchRoot: SearchRoot,
	config: FileToolsConfig,
	ignoreSnapshot: IgnoreSnapshot,
	ignoreBypass: boolean,
	signal: AbortSignal | undefined,
	matchesGlob?: (candidate: string, kind: FindEntry["kind"]) => boolean,
): WalkState {
	return {
		workspaceRoot,
		searchRoot,
		config,
		ignoreSnapshot,
		ignoreBypass,
		...(signal !== undefined ? { signal } : {}),
		entries: [],
		scannedEntries: 0,
		ignoredCount: 0,
		skippedCount: 0,
		truncated: false,
		maxEntriesScanned: config.limits.find_max_entries_scanned,
		...(matchesGlob !== undefined ? { matchesGlob } : {}),
	};
}

async function walkDirectory(
	state: WalkState,
	absoluteDirectory: string,
	displayDirectory: string,
	workspaceDirectory: string | undefined,
	searchRelativeDirectory: string,
): Promise<void> {
	assertNotAborted(state.signal);
	if (state.truncated) return;
	const directoryIdentity = toolPathIdentity(displayDirectory, absoluteDirectory, workspaceDirectory);
	if (isBlockedPath(state.config, directoryIdentity)) return;
	if (!state.ignoreBypass && isIgnoredPath(state.config, directoryIdentity)) return;
	if (!state.ignoreBypass && workspaceDirectory !== undefined && workspaceDirectory !== state.searchRoot.workspacePath) {
		const decision = state.ignoreSnapshot.evaluate({ path: workspaceDirectory, kind: "directory", intent: "traverse" });
		if (decision.ignored && decision.prune) return;
	}

	let entries;
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (displayDirectory === state.searchRoot.relativePath) throw error;
		if (isAccessDenied(error)) state.skippedCount += 1;
		return;
	}

	for (const entry of entries.sort((left, right) => compareStableString(left.name, right.name))) {
		assertNotAborted(state.signal);
		if (state.truncated) return;
		const childDisplay = childDisplayPath(displayDirectory, entry.name);
		const childWorkspace = childWorkspacePath(workspaceDirectory, entry.name);
		const childAbsolutePath = path.join(absoluteDirectory, entry.name);
		const identity = toolPathIdentity(childDisplay, childAbsolutePath, childWorkspace);
		if (isBlockedPath(state.config, identity)) continue;
		if (state.scannedEntries >= state.maxEntriesScanned) {
			state.truncated = true;
			return;
		}
		state.scannedEntries += 1;
		if (entry.isSymbolicLink()) continue;

		const childSearchPath = searchRelativeDirectory === "." ? entry.name : `${searchRelativeDirectory}/${entry.name}`;
		if (entry.isDirectory()) {
			await visitDirectoryEntry(state, childAbsolutePath, childDisplay, childWorkspace, childSearchPath, identity);
			continue;
		}
		if (!entry.isFile()) continue;
		visitFileEntry(state, childDisplay, childWorkspace, childSearchPath, identity);
	}
}

async function visitDirectoryEntry(
	state: WalkState,
	absolutePath: string,
	displayPath: string,
	workspacePath: string | undefined,
	searchPath: string,
	identity: ReturnType<typeof toolPathIdentity>,
): Promise<void> {
	const decision = state.ignoreBypass || workspacePath === undefined
		? { ignored: false, prune: false }
		: state.ignoreSnapshot.evaluate({ path: workspacePath, kind: "directory", intent: "traverse" });
	const ignoredByConfig = !state.ignoreBypass && isIgnoredPath(state.config, identity);
	const ignored = ignoredByConfig || decision.ignored;
	if (!ignored) recordFindEntry(state, displayPath, searchPath, "directory");
	if (ignored) {
		state.ignoredCount += 1;
		if (ignoredByConfig || decision.prune) return;
	}
	await walkDirectory(state, absolutePath, displayPath, workspacePath, searchPath);
}

function visitFileEntry(
	state: WalkState,
	displayPath: string,
	workspacePath: string | undefined,
	searchPath: string,
	identity: ReturnType<typeof toolPathIdentity>,
): void {
	const ignoredByConfig = !state.ignoreBypass && isIgnoredPath(state.config, identity);
	const decision = state.ignoreBypass || workspacePath === undefined ? { ignored: false } : state.ignoreSnapshot.evaluate({ path: workspacePath, kind: "file", intent: "search" });
	if (ignoredByConfig || decision.ignored) {
		state.ignoredCount += 1;
		return;
	}
	recordFindEntry(state, displayPath, searchPath, "file");
}

function matchesCandidate(state: WalkState, searchPath: string, kind: FindEntry["kind"]): boolean {
	return state.matchesGlob === undefined || state.matchesGlob(searchPath, kind);
}

function recordFindEntry(state: WalkState, displayPath: string, searchPath: string, kind: FindEntry["kind"]): void {
	if (matchesCandidate(state, searchPath, kind)) state.entries.push(createFindEntry(displayPath, kind));
}

function findNearbyResults(suggestions: RankedFindEntry[]): FindNearbyResult[] {
	const results: FindNearbyResult[] = [];
	const seen = new Set<string>();
	for (const { entry } of suggestions) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		results.push({ path: entry.path, kind: entry.kind, reason: "name similarity" });
		if (results.length >= FIND_NEARBY_LIMIT) return results;
	}
	return results;
}

function renderSuccess(input: {
	query: string;
	path: string;
	strategy: "exact" | "glob" | "fuzzy";
	ranked: RankedFindEntry[];
	totalMatches: number;
	scannedEntries: number;
	ignoredCount: number;
	skippedCount: number;
	scanTruncated: boolean;
	config: FileToolsConfig;
	related?: RepoMapRelatedResult[];
	nearby?: FindNearbyResult[];
	missingPrefix?: string;
	nearbyDirectory?: string;
}): FindSuccess {
	const limitedCandidates = selectRankedFindEntries(input.ranked, input.config.limits.find_result_limit);
	const limited = limitedCandidates.map((item) => toMatch(item.entry));
	const candidateSources = Object.fromEntries(limitedCandidates.map((item) => [item.entry.path, rankingEvidenceSources(item.evidence)]));
	const resultLimited = limited.length < input.totalMatches;
	return renderFindResults({
		query: input.query,
		path: input.path,
		strategy: input.strategy,
		totalMatches: input.totalMatches,
		scannedEntries: input.scannedEntries,
		matches: limited,
		candidateSources,
		ignoredCount: input.ignoredCount,
		skippedCount: input.skippedCount,
		scanTruncated: input.scanTruncated,
		resultLimited,
		outputTokenBudget: input.config.limits.find_output_token_budget,
		...(input.related !== undefined ? { related: input.related } : {}),
		...(input.nearby !== undefined ? { nearby: input.nearby } : {}),
		...(input.missingPrefix !== undefined ? { missingPrefix: input.missingPrefix } : {}),
		...(input.nearbyDirectory !== undefined ? { nearbyDirectory: input.nearbyDirectory } : {}),
	});
}

async function renderMissingPrefix(
	params: NormalizedFindParams,
	searchRoot: SearchRoot,
	config: FileToolsConfig,
	missingPrefix: string,
	nearby: unknown,
	related: RepoMapRelatedResult[] = [],
): Promise<FindSuccess> {
	const nearbyDirectory = typeof nearby === "string" ? nearby : undefined;
	return renderFindResults({
		query: params.query,
		path: searchRoot.relativePath,
		strategy: "glob",
		totalMatches: 0,
		scannedEntries: 0,
		matches: [],
		ignoredCount: 0,
		skippedCount: 0,
		scanTruncated: false,
		resultLimited: false,
		outputTokenBudget: config.limits.find_output_token_budget,
		missingPrefix,
		...(related.length > 0 ? { related } : {}),
		...(nearbyDirectory !== undefined ? { nearbyDirectory } : {}),
	});
}

function toMatch(entry: FindEntry): FindMatch {
	return { path: entry.path, kind: entry.kind };
}

async function childSearchRoot(root: SearchRoot, prefix: string, config: FileToolsConfig): Promise<ToolOutcome<SearchRoot>> {
	if (prefix === ".") return root;
	let displayPath = root.relativePath;
	let workspacePath = root.workspacePath;
	let absolutePath = root.absolutePath;
	for (const segment of prefix.split("/")) {
		displayPath = childDisplayPath(displayPath, segment);
		workspacePath = childWorkspacePath(workspacePath, segment);
		absolutePath = path.join(absolutePath, segment);
		if (isBlockedPath(config, toolPathIdentity(displayPath, absolutePath, workspacePath))) {
			return fail("PROTECTED_PATH", "Path is blocked by file-tools config.", { path: displayPath });
		}
		try {
			const info = await lstat(absolutePath);
			if (info.isSymbolicLink() || !info.isDirectory()) {
				return fail("PATH_NOT_FOUND", "Glob static prefix does not exist.", { details: { missingPrefix: displayPath } });
			}
		} catch {
			return fail("PATH_NOT_FOUND", "Glob static prefix does not exist.", {
				details: { missingPrefix: displayPath, nearbyDirectory: await nearbyDirectory(path.dirname(absolutePath), segment, path.dirname(displayPath)) },
			});
		}
	}
	return { relativePath: displayPath, absolutePath, ...(workspacePath !== undefined ? { workspacePath } : {}) };
}

function isDirectoryIgnored(root: SearchRoot, config: FileToolsConfig, ignoreSnapshot: IgnoreSnapshot): boolean {
	if (isIgnoredPath(config, toolPathIdentity(root.relativePath, root.absolutePath, root.workspacePath))) return true;
	if (root.workspacePath === undefined || root.workspacePath === ".") return false;
	return ignoreSnapshot.evaluate({ path: root.workspacePath, kind: "directory", intent: "traverse" }).ignored;
}

async function nearbyDirectory(parentAbsolutePath: string, missingName: string, rootPath: string): Promise<string | undefined> {
	let entries;
	try {
		entries = await readdir(parentAbsolutePath, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const ranked = candidates
		.map((name) => ({ name, score: simpleSimilarity(missingName.toLowerCase(), name.toLowerCase()) }))
		.filter((item) => item.score >= 0.45)
		.sort((left, right) => right.score - left.score || compareStableString(left.name, right.name));
	const best = ranked[0];
	if (best === undefined) return undefined;
	return rootPath === "." ? best.name : `${rootPath}/${best.name}`;
}

function simpleSimilarity(left: string, right: string): number {
	if (left === right) return 1;
	const maxLength = Math.max(left.length, right.length);
	if (maxLength === 0) return 0;
	let same = 0;
	const limit = Math.min(left.length, right.length);
	for (let index = 0; index < limit; index += 1) {
		if (left[index] === right[index]) same += 1;
	}
	return same / maxLength;
}

function createQueryGlobFilter(query: string): ToolOutcome<GlobFilter | undefined> {
	try {
		const scanned = picomatch.scan(query, { tokens: true });
		if (!scanned.isGlob) return undefined;
		const basenameOnly = !query.includes("/");
		const literalBase = basenameOnly ? "." : scanned.base;
		const base = normalizeRelative(literalBase.length === 0 ? "." : literalBase);
		const matchPattern = picomatch(query, { dot: true, nonegate: true });
		return {
			base,
			matches(candidate, kind) {
				const target = basenameOnly ? path.posix.basename(candidate) : candidate;
				return matchPattern(target) || (kind === "directory" && matchPattern(`${target}/`));
			},
		};
	} catch (error) {
		return fail("INVALID_PATH", "query glob is not valid.", { details: { error: error instanceof Error ? error.message : String(error) } });
	}
}

function normalizeRelative(value: string): string {
	return value.replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/").replace(/\/$/u, "") || ".";
}

function childDisplayPath(parent: string, child: string): string {
	if (parent === ".") return normalizeRelative(child);
	if (path.isAbsolute(parent)) return path.normalize(path.join(parent, child));
	return normalizeRelative(`${parent}/${child}`);
}

function childWorkspacePath(parent: string | undefined, child: string): string | undefined {
	if (parent === undefined) return undefined;
	return parent === "." ? child : `${parent}/${child}`;
}

function relativeToSearchRoot(searchRoot: string, candidate: string): string {
	if (candidate === searchRoot) return ".";
	if (searchRoot === ".") return candidate;
	return candidate.slice(searchRoot.length + 1);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AbortFind();
}

class AbortFind extends Error {}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
