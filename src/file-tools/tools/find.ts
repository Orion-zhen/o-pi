import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import pLimit from "p-limit";

import { ignoreConfigFromFileTools, isBlockedPath, isIgnoredPath, loadFileToolsConfig, toolPathIdentity, type FileToolsConfig } from "../config.js";
import { fail, isAccessDenied, isFailed, protectedPathFailure } from "../core/errors.js";
import { createFindEntry, rankFindEntries, rankGlobEntries, type RankedFindEntry } from "../find/ranker.js";
import { renderFindResults } from "../find/renderer.js";
import { defaultIgnoreEngine } from "../ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "../ignore/ignore-types.js";
import { guardExistingPath, PathGuardBlockedError } from "../../safety/path-guard.js";
import { normalizeToolPath, resolveWorkspaceRoot } from "../core/path-resolver.js";
import type { FindEntry, FindMatch, FindParams, FindSuccess, ToolOutcome } from "../types.js";
import type { RepoMapFileToolQuery } from "../../repo-map/file-tool-query.js";
import type { RepoMapQueryCandidate } from "../../repo-map/query.js";

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

const REPO_MAP_VALIDATION_CONCURRENCY = 8;

/** find 是路径定位器：自动路由 exact、glob 和 fuzzy；激活后的图候选只读取字节以复核 hash，不跟随 symlink。 */
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
				truncated: false,
				config,
			});
		}
		if (exact !== undefined) {
			return renderSuccess({
				query: normalized.query,
				path: searchRoot.relativePath,
				strategy: "exact",
				ranked: [{ entry: exact, score: 100_000 }],
				totalMatches: 1,
				scannedEntries: 0,
				ignoredCount: 0,
				skippedCount: 0,
				truncated: false,
				config,
			});
		}

		if (isGlobQuery(normalized.query)) {
			return await runGlobSearch(workspaceRoot, searchRoot, normalized, config, ignoreSnapshot, signal);
		}
		return await runFuzzySearch(workspaceRoot, searchRoot, normalized, config, ignoreSnapshot, signal, runtime);
	} catch (error) {
		if (error instanceof AbortFind) return fail("OPERATION_ABORTED", "find was aborted.", { path: searchRoot.relativePath });
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
	return { query: params.query, path: normalizedSearchPath.path };
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

async function runGlobSearch(
	workspaceRoot: string,
	searchRoot: SearchRoot,
	params: NormalizedFindParams,
	config: FileToolsConfig,
	ignoreSnapshot: IgnoreSnapshot,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome<FindSuccess>> {
	const glob = globInfo(params.query);
	if (isFailed(glob)) return glob;
	const walkRoot = await childSearchRoot(searchRoot, glob.base, config);
	if (isFailed(walkRoot)) return renderMissingPrefix(params, searchRoot, config, glob.base, walkRoot.error.details?.["nearbyDirectory"]);
	const matchPattern = picomatch(params.query, { dot: true, nonegate: true });
	const state = createWalkState(
		workspaceRoot,
		searchRoot,
		config,
		ignoreSnapshot,
		isDirectoryIgnored(walkRoot, config, ignoreSnapshot),
		signal,
		(candidate, kind) => {
			if (matchPattern(candidate)) return true;
			return kind === "directory" && matchPattern(`${candidate}/`);
		},
	);
	await walkDirectory(
		state,
		walkRoot.absolutePath,
		walkRoot.relativePath,
		walkRoot.workspacePath,
		relativeToSearchRoot(searchRoot.relativePath, walkRoot.relativePath),
	);
	const ranked = rankGlobEntries(state.entries, params.query, searchRoot.relativePath);
	return renderSuccess({
		query: params.query,
		path: searchRoot.relativePath,
		strategy: "glob",
		ranked,
		totalMatches: ranked.length,
		scannedEntries: state.scannedEntries,
		ignoredCount: state.ignoredCount,
		skippedCount: state.skippedCount,
		truncated: state.truncated,
		config,
	});
}

async function runFuzzySearch(
	workspaceRoot: string,
	searchRoot: SearchRoot,
	params: NormalizedFindParams,
	config: FileToolsConfig,
	ignoreSnapshot: IgnoreSnapshot,
	signal: AbortSignal | undefined,
	runtime: FindRuntime,
): Promise<ToolOutcome<FindSuccess>> {
	const state = createWalkState(workspaceRoot, searchRoot, config, ignoreSnapshot, isDirectoryIgnored(searchRoot, config, ignoreSnapshot), signal);
	const [, repoMapRanked] = await Promise.all([
		walkDirectory(state, searchRoot.absolutePath, searchRoot.relativePath, searchRoot.workspacePath, "."),
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
	const ranked = rankFindEntries(state.entries, params.query, searchRoot.relativePath);
	const merged = mergeFindCandidates(ranked.matches, repoMapRanked);
	return renderSuccess({
		query: params.query,
		path: searchRoot.relativePath,
		strategy: "fuzzy",
		ranked: merged,
		totalMatches: merged.length,
		scannedEntries: state.scannedEntries,
		ignoredCount: state.ignoredCount,
		skippedCount: state.skippedCount,
		truncated: state.truncated,
		config,
		...(merged.length === 0 ? { suggestions: ranked.suggestions.map((item) => toMatch(item.entry)) } : {}),
	});
}

async function safeRepoMapFindCandidates(
	queryLayer: RepoMapFileToolQuery | undefined,
	input: {
		workspaceRoot: string;
		searchRoot: SearchRoot;
		query: string;
		config: FileToolsConfig;
		ignoreSnapshot: IgnoreSnapshot;
		ignoreBypass: boolean;
		signal: AbortSignal | undefined;
	},
): Promise<RankedFindEntry[]> {
	if (queryLayer === undefined) return [];
	try {
		const queried = await queryLayer.query({
			requestedPath: input.searchRoot.absolutePath,
			query: input.query,
			limit: Math.max(24, input.config.limits.find_result_limit * 4),
		});
		if (queried === undefined) return [];
		const hashes = new Map<string, Promise<string | undefined>>();
		const limit = pLimit(REPO_MAP_VALIDATION_CONCURRENCY);
		const candidates = await Promise.all(queried.candidates.map((candidate) => limit(async () => {
			assertNotAborted(input.signal);
			return await validateRepoMapFindCandidate(candidate, queried.root, input, hashes);
		})));
		return candidates.filter((candidate): candidate is RankedFindEntry => candidate !== undefined);
	} catch (error) {
		if (error instanceof AbortFind) throw error;
		return [];
	}
}

async function validateRepoMapFindCandidate(
	candidate: RepoMapQueryCandidate,
	mapRoot: string,
	input: {
		workspaceRoot: string;
		searchRoot: SearchRoot;
		config: FileToolsConfig;
		ignoreSnapshot: IgnoreSnapshot;
		ignoreBypass: boolean;
		signal: AbortSignal | undefined;
	},
	hashes: Map<string, Promise<string | undefined>>,
): Promise<RankedFindEntry | undefined> {
	const absolutePath = path.resolve(mapRoot, candidate.path);
	const searchRelative = relativeInside(input.searchRoot.absolutePath, absolutePath);
	if (searchRelative === undefined || searchRelative === ".") return undefined;
	const workspaceRelative = relativeInside(input.workspaceRoot, absolutePath);
	if (workspaceRelative === undefined) return undefined;
	const displayPath = childDisplayPath(input.searchRoot.relativePath, searchRelative);
	const identity = toolPathIdentity(displayPath, absolutePath, workspaceRelative);
	if (isBlockedPath(input.config, identity)) return undefined;
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
	const pathOnly = candidate.reasons.every((reason) => reason === "exact path" || reason === "exact filename" || reason === "path match");
	if (!pathOnly && !await matchesCurrentHash(absolutePath, candidate.contentHash, input.signal, hashes)) return undefined;
	for (const related of candidate.relatedEdges.flatMap((edge) => edge.relatedFiles)) {
		const relatedAbsolutePath = path.resolve(mapRoot, related.path);
		if (relativeInside(input.searchRoot.absolutePath, relatedAbsolutePath) === undefined) return undefined;
		if (!await matchesCurrentHash(relatedAbsolutePath, related.contentHash, input.signal, hashes)) return undefined;
	}
	return {
		entry: createFindEntry(displayPath, "file"),
		score: repoMapFindScore(candidate),
	};
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

function repoMapFindScore(candidate: RepoMapQueryCandidate): number {
	if (candidate.reasons.includes("exact path")) return 98_000;
	if (candidate.reasons.includes("exact filename")) return 89_000;
	if (candidate.reasons.some((reason) => reason === "exact qualified symbol" || reason === "exact symbol" || reason === "short symbol")) return 78_000 + candidate.score;
	if (candidate.reasons.includes("definition")) return 74_000 + candidate.score;
	if (candidate.reasons.includes("alias")) return 73_500 + candidate.score - candidate.hop * 1_000;
	if (candidate.reasons.includes("registration") || candidate.reasons.includes("entrypoint")) return 73_000 + candidate.score;
	if (candidate.reasons.includes("public api")) return 72_000 + candidate.score;
	if (candidate.reasons.includes("export")) return 70_000 + candidate.score;
	if (candidate.reasons.includes("component") || candidate.reasons.includes("package")) return 60_000 + candidate.score;
	if (candidate.reasons.includes("path match")) return 55_000 + candidate.score;
	return 32_000 + candidate.score;
}

function mergeFindCandidates(primary: RankedFindEntry[], repoMap: RankedFindEntry[]): RankedFindEntry[] {
	const byPath = new Map<string, RankedFindEntry>();
	for (const candidate of [...primary, ...repoMap]) {
		const existing = byPath.get(candidate.entry.path);
		if (existing === undefined || candidate.score > existing.score) byPath.set(candidate.entry.path, candidate);
	}
	return [...byPath.values()].sort((left, right) => right.score - left.score || compareStableString(left.entry.path, right.entry.path));
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
	if (!ignored && matchesCandidate(state, searchPath, "directory")) state.entries.push(createFindEntry(displayPath, "directory"));
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
	if (matchesCandidate(state, searchPath, "file")) state.entries.push(createFindEntry(displayPath, "file"));
}

function matchesCandidate(state: WalkState, searchPath: string, kind: FindEntry["kind"]): boolean {
	return state.matchesGlob === undefined || state.matchesGlob(searchPath, kind);
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
	truncated: boolean;
	config: FileToolsConfig;
	suggestions?: FindMatch[];
	missingPrefix?: string;
	nearbyDirectory?: string;
}): FindSuccess {
	const limited = selectLimitedRanked(input.ranked, input.config.limits.find_result_limit).map((item) => toMatch(item.entry));
	const totals = countKinds(input.ranked.map((item) => item.entry));
	return renderFindResults({
		query: input.query,
		path: input.path,
		strategy: input.strategy,
		totalMatches: input.totalMatches,
		totalFiles: totals.files,
		totalDirectories: totals.directories,
		scannedEntries: input.scannedEntries,
		matches: limited,
		ignoredCount: input.ignoredCount,
		skippedCount: input.skippedCount,
		truncated: input.truncated || limited.length < input.totalMatches,
		outputTokenBudget: input.config.limits.find_output_token_budget,
		...(input.suggestions !== undefined ? { suggestions: input.suggestions } : {}),
		...(input.missingPrefix !== undefined ? { missingPrefix: input.missingPrefix } : {}),
		...(input.nearbyDirectory !== undefined ? { nearbyDirectory: input.nearbyDirectory } : {}),
	});
}

function selectLimitedRanked(ranked: RankedFindEntry[], limit: number): RankedFindEntry[] {
	if (ranked.length <= limit) return ranked;
	const selected: RankedFindEntry[] = [];
	const selectedPaths = new Set<string>();
	const perTopDirectory = new Map<string, number>();
	const cap = Math.max(4, Math.ceil(limit / 4));
	for (const item of ranked) {
		if (selected.length >= limit) break;
		const group = topDirectory(item.entry.path);
		if ((perTopDirectory.get(group) ?? 0) >= cap && hasLowerRepresentedGroup(ranked, selectedPaths, perTopDirectory)) continue;
		selected.push(item);
		selectedPaths.add(item.entry.path);
		perTopDirectory.set(group, (perTopDirectory.get(group) ?? 0) + 1);
	}
	for (const item of ranked) {
		if (selected.length >= limit) break;
		if (selectedPaths.has(item.entry.path)) continue;
		selected.push(item);
	}
	return selected.sort((left, right) => ranked.indexOf(left) - ranked.indexOf(right));
}

function hasLowerRepresentedGroup(ranked: RankedFindEntry[], selectedPaths: Set<string>, counts: Map<string, number>): boolean {
	for (const item of ranked) {
		if (selectedPaths.has(item.entry.path)) continue;
		if (!counts.has(topDirectory(item.entry.path))) return true;
	}
	return false;
}

function topDirectory(value: string): string {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

async function renderMissingPrefix(
	params: NormalizedFindParams,
	searchRoot: SearchRoot,
	config: FileToolsConfig,
	missingPrefix: string,
	nearby: unknown,
): Promise<FindSuccess> {
	const nearbyDirectory = typeof nearby === "string" ? nearby : undefined;
	return renderFindResults({
		query: params.query,
		path: searchRoot.relativePath,
		strategy: "glob",
		totalMatches: 0,
		totalFiles: 0,
		totalDirectories: 0,
		scannedEntries: 0,
		matches: [],
		ignoredCount: 0,
		skippedCount: 0,
		truncated: false,
		outputTokenBudget: config.limits.find_output_token_budget,
		missingPrefix,
		...(nearbyDirectory !== undefined ? { nearbyDirectory } : {}),
	});
}

function countKinds(entries: FindEntry[]): { files: number; directories: number } {
	let files = 0;
	let directories = 0;
	for (const entry of entries) {
		if (entry.kind === "file") files += 1;
		else directories += 1;
	}
	return { files, directories };
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

function globInfo(query: string): ToolOutcome<{ base: string }> {
	try {
		const scanned = picomatch.scan(query, { tokens: true });
		const base = normalizeRelative(scanned.base.length === 0 ? "." : scanned.base);
		return { base };
	} catch (error) {
		return fail("INVALID_PATH", "query is not a valid glob.", { details: { error: error instanceof Error ? error.message : String(error) } });
	}
}

function isGlobQuery(query: string): boolean {
	if (!/[*?[\]{}]/u.test(query) && !/[!+@?*]\(/u.test(query)) return false;
	try {
		return picomatch.scan(query).isGlob === true;
	} catch {
		return false;
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
