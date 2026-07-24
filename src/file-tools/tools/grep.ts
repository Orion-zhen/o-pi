import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import pLimit from "p-limit";

import { fail, isFailed } from "../core/errors.js";
import { getGrepIndex } from "../grep/indexer.js";
import { decodeTextFile } from "../core/text-file.js";
import { packGrepResults, renderGrepSuccess, selectGrepCandidatesForPacking } from "../grep/packer.js";
import { rankGrepRegions, type RankedGrepRegion } from "../grep/ranker.js";
import { compareRankedGrepRegions, fuseRankedGrepSources, mergeRankedGrepSources } from "../grep/fusion.js";
import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE } from "../ranking-evidence.js";
import { buildLineIndex, byteRangeForLinesWithIndex, extractByteRange, parseCodeUnits, type IndexedCodeUnit, type LineIndex } from "../../code-index/parser.js";
import { normalizeToolPath, resolveWorkspaceRoot } from "../core/path-resolver.js";
import type { FailedResult, FileToolLspHooks, FileToolLspSymbolCandidate, GrepMatchMode, GrepNearbyResult, GrepParams, GrepScopeError, GrepSuccess, RepoMapRelatedResult, ToolOutcome } from "../types.js";
import type { RepoMapFileToolQuery } from "../../repo-map/file-tool-query.js";
import type { RepoMapQueryCandidate } from "../../repo-map/query.js";
import { formatRepoMapAliasReason, isRepoMapMainCandidate, isRepoMapNavigationCandidate, repoMapNavigationRelation, repoMapRankingEvidence } from "../repo-map-ranking.js";

interface NormalizedGrepParams {
	query: string;
	paths: string[];
	match: GrepMatchMode;
	glob?: string;
}

interface GrepScopeResult {
	path: string;
	match: GrepMatchMode;
	strategy: string[];
	totalCandidates: number;
	regions: RankedGrepRegion[];
	sourceText: Map<string, string>;
	scannedFiles: number;
	skipped: GrepScopeIndexStats;
	scanComplete: boolean;
	nearby: GrepNearbyResult[];
	tokenBudget: number;
	resultLimit: number;
	related?: RepoMapRelatedResult[];
}

type GrepScopeIndexStats = NonNullable<GrepSuccess["skipped_files"]>;

interface GrepRankingContext {
	readonly unitsByPath: Map<string, IndexedCodeUnit[]>;
	readonly unitsByIdByPath: Map<string, Map<string, IndexedCodeUnit>>;
	readonly sourceHashes: Map<string, string>;
	readonly lineIndexes: Map<string, LineIndex>;
	readonly repoMapReasons: WeakMap<RepoMapQueryCandidate, string[]>;
	readonly lspRegions: WeakMap<FileToolLspSymbolCandidate, RankedGrepRegion>;
	readonly repoMapRegions: WeakMap<RepoMapQueryCandidate, RankedGrepRegion>;
}

export interface GrepRuntime {
	/** 可选 LSP symbol 后端；命中仍需经过 grep scope、ignore 和预算过滤。 */
	lsp?: FileToolLspHooks;
	/** 可选源码读取器；默认读取本地 UTF-8 文件。 */
	readSourceText?: (file: { path: string; absolutePath: string }, signal: AbortSignal | undefined) => Promise<ToolOutcome<string>>;
	/** 可选 Repo Map 查询层；activation、generation 与 freshness gate 由实现方封装。 */
	repoMap?: RepoMapFileToolQuery;
}

const SOURCE_READ_CONCURRENCY = 8;
const GREP_RELATED_TRIGGER = 4;
const GREP_RELATED_LIMIT = 3;

/** grep 是单入口代码检索器：自动路由文本、symbol、regex 和一跳关系，返回预算内代码区域。 */
export async function grepWorkspaceFiles(cwd: string, params: GrepParams, signal?: AbortSignal, runtime: GrepRuntime = {}): Promise<ToolOutcome<GrepSuccess>> {
	const validation = validateGrepParams(params);
	if (isFailed(validation)) return validation;
	const regex = validation.match === "regex" ? compileRegex(validation.query) : undefined;
	if (isFailed(regex)) return regex;
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const scopes = normalizeGrepScopes(workspaceRoot, validation.paths);
	if (isFailed(scopes)) return scopes;
	const effectiveScopes = await resolveEffectiveGrepScopes(workspaceRoot, scopes);
	const scopeErrors: GrepScopeError[] = [];
	const successes: GrepScopeResult[] = [];
	for (const scope of effectiveScopes) {
		const result = await grepScope(cwd, { ...params, path: [scope.path] }, signal, runtime, regex);
		if (isFailed(result)) scopeErrors.push({ path: scope.path, error: result.error });
		else successes.push(result);
	}
	if (successes.length === 0) {
		const first = scopeErrors[0];
		if (first === undefined) return fail("PATH_NOT_FOUND", "No searchable scope was provided.");
		return withGrepScopeErrors({ status: "failed", error: first.error }, validation.paths, scopeErrors);
	}
	const paths = successes.map((result) => result.path);
	const regions = mergeScopeRegions(successes.flatMap((result) => result.regions));
	const sourceText = new Map<string, string>();
	for (const result of successes) for (const [filePath, text] of result.sourceText) sourceText.set(filePath, text);
	const strategy = [...new Set(successes.flatMap((result) => result.strategy))];
	const related = regions.length < GREP_RELATED_TRIGGER ? mergeGrepRelated(successes.flatMap((result) => result.related ?? [])) : [];
	const nearby = regions.length === 0 ? mergeGrepNearby(successes.flatMap((result) => result.nearby)) : [];
	const skipped = mergeGrepSkipped(successes.map((result) => result.skipped));
	return packGrepResults({
		query: validation.query,
		path: paths[0] ?? ".",
		paths,
		scopeErrors,
		match: validation.match,
		strategy,
		totalCandidates: regions.length,
		regions,
		sourceText,
		tokenBudget: Math.min(...successes.map((result) => result.tokenBudget)),
		resultLimit: Math.min(...successes.map((result) => result.resultLimit)),
		scannedFiles: successes.reduce((sum, result) => sum + result.scannedFiles, 0),
		...(Object.keys(skipped).length > 0 ? { skipped } : {}),
		scanComplete: successes.every((result) => result.scanComplete),
		nearby,
		...(related.length > 0 ? { related } : {}),
	});
}

async function grepScope(
	cwd: string,
	params: GrepParams,
	signal: AbortSignal | undefined,
	runtime: GrepRuntime,
	compiledRegex: RegExp | undefined,
): Promise<ToolOutcome<GrepScopeResult>> {
	const validation = validateGrepParams(params);
	if (isFailed(validation)) return validation;
	const regex = compiledRegex ?? (validation.match === "regex" ? compileRegex(validation.query) : undefined);
	if (isFailed(regex)) return regex;
	const scopePath = validation.paths[0];
	if (scopePath === undefined) return fail("INVALID_PATH", "path must contain at least one scope.");
	const index = await getGrepIndex(cwd, { ...validation, path: scopePath }, signal);
	if (isFailed(index)) return index;
	const sourceText = new Map(index.sourceText);
	const filesByPath = new Map<string, { path: string; absolutePath: string; size?: number }>(index.scopedFiles.map((file) => [file.path, file]));
	for (const file of index.files) filesByPath.set(file.path, file);
	const rankingContext = createGrepRankingContext(index.files);
	const rankInput = {
		query: validation.query,
		match: validation.match,
		files: index.files.map((file) => ({ path: file.path, units: file.index.units, parserStatus: file.parserStatus })),
		sourceText,
		lineIndexes: rankingContext.lineIndexes,
		allowMetadataCandidates: validation.match !== "auto",
		...(regex !== undefined ? { regex } : {}),
	};
	const rankedSourceCount = sourceText.size;
	let ranked = rankGrepRegions(rankInput);
	const mainPaths = new Set(index.files.map((file) => file.path));
	const repoMapQuery = repoMapQueryForGrep(validation);
	const [repoMapResult, lspSymbolCandidates] = await Promise.all([
		repoMapQuery === undefined
			? Promise.resolve(undefined)
			: safeRepoMapCandidates(runtime.repoMap, {
				requestedPath: index.root.realPath,
				query: repoMapQuery,
				limit: validation.match === "auto"
					? Math.max(24, index.config.limits.grep_result_limit * 6)
					: Math.max(16, index.config.limits.grep_result_limit * 4),
			}),
		safeLspSymbolCandidates(runtime.lsp, {
			workspaceRoot: index.workspaceRoot,
			query: validation.query,
			path: index.root.relativePath,
			extensions: scopeExtensions(index, validation.glob),
			allowedPaths: mainPaths,
			...(signal !== undefined ? { signal } : {}),
		}, validation.match),
	]);
	const scopePaths = new Set(index.scopedFiles.map((file) => file.path));
	const scopedRepoMapCandidates = repoMapResult?.candidates.filter((candidate) =>
		(validation.match === "auto" ? mainPaths : scopePaths).has(candidate.path)
		&& (validation.match !== "auto"
			|| candidate.relatedEdges.every((edge) => edge.relatedFiles.every((file) => mainPaths.has(file.path))))) ?? [];
	const lspSourcePaths = limitedUniquePaths(lspSymbolCandidates.map((candidate) => candidate.path), index.config.limits.grep_result_limit * 4);
	const repoMapSourcePaths = limitedUniquePaths(
		scopedRepoMapCandidates.flatMap((candidate) => validation.match === "auto"
			? [candidate.path, ...candidate.relatedEdges.flatMap((edge) => edge.relatedFiles.map((file) => file.path))]
			: [candidate.path]),
		index.config.limits.grep_result_limit * (validation.match === "auto" ? 10 : 4),
	);
	const candidatePaths = await filterCandidateSourcePaths(
		limitedUniquePaths([...lspSourcePaths, ...repoMapSourcePaths], lspSourcePaths.length + repoMapSourcePaths.length),
		filesByPath,
		index.config.limits.grep_max_file_bytes,
		signal,
	);
	if (isFailed(candidatePaths)) return candidatePaths;
	const candidateSource = await loadCandidateSourceText(
		sourceText,
		filesByPath,
		candidatePaths,
		signal,
		runtime,
	);
	if (isFailed(candidateSource)) return candidateSource;
	let lspCandidates = lspRegionsFromCandidates(lspSymbolCandidates, validation.query, validation.match, sourceText, mainPaths, rankingContext);
	let repoMapCandidates = repoMapRegionsFromCandidates(
		scopedRepoMapCandidates,
		sourceText,
		rankingContext,
		validation,
		regex,
	);
	const regions = fuseRankedGrepSources(ranked.regions, lspCandidates, repoMapCandidates);
	const externalRegionSourceCount = sourceText.size;
	const hydrated = await loadCandidateSourceText(sourceText, filesByPath, hydrationPaths(regions, index.config.limits.grep_result_limit), signal, runtime);
	if (isFailed(hydrated)) return hydrated;
	if (sourceText.size !== rankedSourceCount) {
		ranked = rankGrepRegions({
			...rankInput,
			sourceText,
			allowMetadataCandidates: false,
		});
	}
	if (sourceText.size !== externalRegionSourceCount) {
		lspCandidates = lspRegionsFromCandidates(lspSymbolCandidates, validation.query, validation.match, sourceText, mainPaths, rankingContext);
		repoMapCandidates = repoMapRegionsFromCandidates(
			scopedRepoMapCandidates,
			sourceText,
			rankingContext,
			validation,
			regex,
		);
	}
	let finalRegions = fuseRankedGrepSources(ranked.regions, lspCandidates, repoMapCandidates);
	if (validation.match !== "auto" && finalRegions.length === 0) {
		const scanned = await scanFallbackSourceText({
			sourceText,
			files: index.files,
			query: validation.query,
			match: validation.match,
			regex,
			signal,
			runtime,
			limit: Math.max(1, index.config.limits.grep_result_limit),
		});
		if (isFailed(scanned)) return scanned;
		ranked = rankGrepRegions({
			...rankInput,
			sourceText,
			allowMetadataCandidates: false,
		});
		finalRegions = fuseRankedGrepSources(ranked.regions, lspCandidates, repoMapCandidates);
	}
	const strategy = [...ranked.strategy];
	if (lspCandidates.length > 0) strategy.push("lsp");
	if (repoMapCandidates.length > 0) strategy.push("repo-map");
	const related = finalRegions.length < GREP_RELATED_TRIGGER
		? repoMapRelatedRegionsFromCandidates(
			scopedRepoMapCandidates,
			sourceText,
			rankingContext,
			mainPaths,
			{ query: validation.query, match: validation.match },
			regex,
		)
		: [];
	return {
		path: index.root.relativePath,
		match: validation.match,
		strategy,
		totalCandidates: finalRegions.length,
		regions: finalRegions,
		sourceText,
		tokenBudget: index.config.limits.grep_output_token_budget,
		resultLimit: index.config.limits.grep_result_limit,
		scannedFiles: index.scopedFiles.length,
		skipped: index.skipped,
		scanComplete: index.scanComplete,
		nearby: finalRegions.length === 0 ? ranked.nearby : [],
		...(related.length > 0 ? { related } : {}),
	};
}

function createGrepRankingContext(files: Array<{ path: string; index: { units: IndexedCodeUnit[] } }>): GrepRankingContext {
	const unitsByPath = new Map<string, IndexedCodeUnit[]>();
	const unitsByIdByPath = new Map<string, Map<string, IndexedCodeUnit>>();
	for (const file of files) {
		unitsByPath.set(file.path, file.index.units);
	}
	return {
		unitsByPath,
		unitsByIdByPath,
		sourceHashes: new Map(),
		lineIndexes: new Map(),
		repoMapReasons: new WeakMap(),
		lspRegions: new WeakMap(),
		repoMapRegions: new WeakMap(),
	};
}

async function filterCandidateSourcePaths(
	paths: string[],
	filesByPath: Map<string, { path: string; absolutePath: string; size?: number }>,
	maxBytes: number,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome<string[]>> {
	const limit = pLimit(SOURCE_READ_CONCURRENCY);
	const checked = await Promise.all(paths.map((filePath) => limit(async () => {
		if (signal?.aborted) return "aborted" as const;
		const file = filesByPath.get(filePath);
		if (file === undefined) return false;
		if (file.size !== undefined) return file.size <= maxBytes;
		try {
			return (await stat(file.absolutePath)).size <= maxBytes;
		} catch {
			return false;
		}
	})));
	if (checked.includes("aborted")) return fail("OPERATION_ABORTED", "grep was aborted.");
	return paths.filter((_filePath, index) => checked[index] === true);
}

async function safeRepoMapCandidates(
	queryLayer: RepoMapFileToolQuery | undefined,
	input: { requestedPath: string; query: string; limit: number },
): Promise<Awaited<ReturnType<RepoMapFileToolQuery["query"]>>> {
	if (queryLayer === undefined) return undefined;
	try {
		return await queryLayer.query(input);
	} catch {
		return undefined;
	}
}

export function formatCompactGrepResult(result: GrepSuccess): string {
	return renderGrepSuccess(result);
}

function validateGrepParams(params: GrepParams): ToolOutcome<NormalizedGrepParams> {
	if (typeof params.query !== "string" || params.query.length === 0) return fail("INVALID_OPERATION", "query must not be empty.");
	if (params.query.includes("\0")) return fail("INVALID_OPERATION", "query must not contain NUL bytes.");
	const paths = params.path ?? ["."];
	if (!Array.isArray(paths) || paths.length === 0) return fail("INVALID_PATH", "path must contain at least one scope.");
	for (const scope of paths) {
		if (typeof scope !== "string" || scope.length === 0) return fail("INVALID_PATH", "path entries must be non-empty strings.");
		if (scope.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: scope });
	}
	const match = params.match ?? "auto";
	if (match !== "auto" && match !== "literal" && match !== "regex") return fail("INVALID_OPERATION", "match must be auto, literal, or regex.", { path: paths[0] ?? "." });
	if (params.glob !== undefined && (typeof params.glob !== "string" || params.glob.length === 0)) {
		return fail("INVALID_PATH", "glob must not be empty.", { path: paths[0] ?? "." });
	}
	return {
		query: params.query,
		paths,
		match,
		...(params.glob !== undefined ? { glob: params.glob } : {}),
	};
}

function normalizeGrepScopes(workspaceRoot: string, paths: string[]): ToolOutcome<Array<{ path: string }>> {
	const normalized: Array<{ path: string }> = [];
	const seen = new Set<string>();
	for (const inputPath of paths) {
		const lexical = normalizeToolPath(workspaceRoot, inputPath);
		if (isFailed(lexical)) return lexical;
		if (seen.has(lexical.relativePath)) continue;
		seen.add(lexical.relativePath);
		normalized.push({ path: lexical.relativePath });
	}
	return normalized;
}

async function resolveEffectiveGrepScopes(workspaceRoot: string, scopes: Array<{ path: string }>): Promise<Array<{ path: string }>> {
	const exists = await Promise.all(scopes.map(async (scope) => {
		try {
			await stat(path.resolve(workspaceRoot, scope.path));
			return true;
		} catch {
			return false;
		}
	}));
	return scopes.filter((scope, index) => !scopes.some((parent, parentIndex) =>
		parentIndex !== index
		&& exists[index] === true
		&& exists[parentIndex] === true
		&& isGrepPathAncestor(path.resolve(workspaceRoot, parent.path), path.resolve(workspaceRoot, scope.path)),
	));
}

function isGrepPathAncestor(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function mergeScopeRegions(regions: RankedGrepRegion[]): RankedGrepRegion[] {
	let merged: RankedGrepRegion[] = [];
	for (const region of regions) merged = mergeRankedGrepSources(merged, [region]);
	return merged.sort(compareRankedGrepRegions);
}

function mergeGrepRelated(results: RepoMapRelatedResult[]): RepoMapRelatedResult[] {
	const merged = new Map<string, RepoMapRelatedResult>();
	for (const result of results) {
		const key = `${result.path}:${result.start_line ?? 0}:${result.end_line ?? 0}:${result.kind}`;
		const existing = merged.get(key);
		if (existing === undefined) merged.set(key, { ...result, relations: [...result.relations] });
		else for (const relation of result.relations) if (!existing.relations.includes(relation)) existing.relations.push(relation);
	}
	return [...merged.values()].slice(0, GREP_RELATED_LIMIT);
}

function mergeGrepNearby(results: GrepNearbyResult[]): GrepNearbyResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		const key = `${result.path}:${result.start_line}:${result.end_line}:${result.kind}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, GREP_RELATED_LIMIT);
}

function mergeGrepSkipped(values: GrepScopeIndexStats[]): GrepScopeIndexStats {
	const merged: GrepScopeIndexStats = {};
	for (const value of values) for (const [key, count] of Object.entries(value)) {
		if (count === undefined) continue;
		const current = merged[key as keyof GrepScopeIndexStats] ?? 0;
		merged[key as keyof GrepScopeIndexStats] = current + count;
	}
	return merged;
}

function withGrepScopeErrors(result: FailedResult, paths: string[], scopeErrors: GrepScopeError[]): FailedResult {
	return {
		...result,
		error: {
			...result.error,
			details: { ...(result.error.details ?? {}), paths, scope_errors: scopeErrors },
		},
	};
}

function compileRegex(query: string): ToolOutcome<RegExp> {
	try {
		return new RegExp(query, "gu");
	} catch (error) {
		return fail("INVALID_REGEX", "query is not a valid regular expression.", {
			details: { error: error instanceof Error ? error.message : String(error) },
		});
	}
}

/** regex 仅用最长字面标识片段召回图候选；严格验证仍使用原表达式。 */
function repoMapQueryForGrep(params: Pick<NormalizedGrepParams, "query" | "match">): string | undefined {
	if (params.match !== "regex") return params.query;
	return params.query.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/gu)
		?.sort((left, right) => right.length - left.length || compareStableString(left, right))[0];
}

async function loadCandidateSourceText(
	sourceText: Map<string, string>,
	filesByPath: Map<string, { path: string; absolutePath: string }>,
	paths: string[],
	signal: AbortSignal | undefined,
	runtime: GrepRuntime,
): Promise<ToolOutcome<Map<string, string>>> {
	const candidates: Array<{ path: string; absolutePath: string }> = [];
	for (const filePath of new Set(paths)) {
		if (sourceText.has(filePath)) continue;
		const file = filesByPath.get(filePath);
		if (file === undefined) continue;
		candidates.push(file);
	}
	const readSource = runtime.readSourceText ?? defaultReadSourceText;
	const limit = pLimit(SOURCE_READ_CONCURRENCY);
	const loadedFiles = await Promise.all(candidates.map((file) => limit(async () => ({
		file,
		loaded: signal?.aborted
			? fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path })
			: await readSource(file, signal),
	}))));
	for (const { file, loaded } of loadedFiles) {
		if (isFailed(loaded)) {
			if (loaded.error.code === "OPERATION_ABORTED") return loaded;
			continue;
		}
		sourceText.set(file.path, loaded);
	}
	return sourceText;
}

async function defaultReadSourceText(file: { path: string; absolutePath: string }, signal: AbortSignal | undefined): Promise<ToolOutcome<string>> {
	let bytes: Buffer;
	try {
		bytes = signal === undefined ? await readFile(file.absolutePath) : await readFile(file.absolutePath, { signal });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
		return fail("FILE_NOT_FOUND", "File cannot be read.", { path: file.path });
	}
	const decoded = decodeTextFile(bytes, file.path);
	if (isFailed(decoded)) return decoded;
	return decoded.text;
}

function scopeExtensions(index: { files: Array<{ path: string }>; scopedFiles: Array<{ path: string }> }, glob: string | undefined): string[] {
	const files = glob === undefined ? index.scopedFiles : index.files;
	return [...new Set(files.map((file) => path.extname(file.path).toLowerCase()).filter((extension) => extension.length > 0))].sort();
}

async function safeLspSymbolCandidates(
	hooks: FileToolLspHooks | undefined,
	input: Parameters<NonNullable<FileToolLspHooks["grepSymbols"]>>[0],
	match: GrepMatchMode,
): Promise<FileToolLspSymbolCandidate[]> {
	if (hooks?.grepSymbols === undefined || match !== "auto" || !looksLikeSymbol(input.query)) return [];
	try {
		return await hooks.grepSymbols(input);
	} catch {
		return [];
	}
}

function lspRegionsFromCandidates(
	candidates: FileToolLspSymbolCandidate[],
	query: string,
	match: GrepMatchMode,
	sourceText: Map<string, string>,
	allowedPaths: Set<string>,
	context: GrepRankingContext,
): RankedGrepRegion[] {
	if (match !== "auto") return [];
	const ranked: RankedGrepRegion[] = [];
	const sourceByRegion = new Map<RankedGrepRegion, FileToolLspSymbolCandidate>();
	for (const candidate of candidates) {
		if (!allowedPaths.has(candidate.path)) continue;
		const text = sourceText.get(candidate.path);
		if (text === undefined) continue;
		const cached = context.lspRegions.get(candidate);
		if (cached !== undefined) {
			ranked.push(cached);
			sourceByRegion.set(cached, candidate);
			continue;
		}
		const range = cachedByteRangeForLines(context, candidate.path, text, candidate.start_line, candidate.end_line);
		const region: RankedGrepRegion = {
			id: `${candidate.path}:${range.startByte}:${range.endByte}:lsp:${candidate.symbol}`,
			path: candidate.path,
			kind: candidate.kind,
			startLine: candidate.start_line,
			endLine: candidate.end_line,
			startByte: range.startByte,
			endByte: range.endByte,
			symbol: candidate.symbol,
			...(candidate.signature !== undefined ? { signature: candidate.signature } : {}),
			tier: lspTier(candidate, query),
			evidence: EMPTY_RANKING_EVIDENCE,
			reasons: [candidate.reason],
			matchLines: [candidate.start_line],
			callees: [],
			imports: [],
			lexicalRelevance: 0,
			pathRelevance: 0,
		};
		context.lspRegions.set(candidate, region);
		ranked.push(region);
		sourceByRegion.set(region, candidate);
	}
	ranked.sort(compareLspCandidates);
	for (const [index, region] of ranked.entries()) {
		const candidate = sourceByRegion.get(region);
		region.evidence = createSourceRankingEvidence(candidate?.origin === "reference" || candidate?.reason === "lsp reference"
			? "lsp-reference"
			: "lsp-workspace-symbol", index + 1);
	}
	return ranked;
}

function repoMapRegionsFromCandidates(
	candidates: RepoMapQueryCandidate[],
	sourceText: ReadonlyMap<string, string>,
	context: GrepRankingContext,
	query: Pick<NormalizedGrepParams, "query" | "match">,
	regex: RegExp | undefined,
): RankedGrepRegion[] {
	const result: RankedGrepRegion[] = [];
	const sourceByRegion = new Map<RankedGrepRegion, RepoMapQueryCandidate>();
	for (const candidate of candidates) {
		if (!isRepoMapMainCandidate(candidate, query.query)) continue;
		const cached = context.repoMapRegions.get(candidate);
		if (cached !== undefined) {
			result.push(cached);
			sourceByRegion.set(cached, candidate);
			continue;
		}
		const text = sourceText.get(candidate.path);
		const units = context.unitsByPath.get(candidate.path);
		if (units === undefined || text === undefined || candidate.contentHash === undefined) continue;
		if (sourceHash(candidate.path, text, context.sourceHashes) !== candidate.contentHash) continue;
		if (query.match === "auto" && !candidate.relatedEdges.every((edge) => edge.relatedFiles.every((related) => {
			const relatedText = sourceText.get(related.path);
			return related.contentHash !== undefined
				&& relatedText !== undefined
				&& sourceHash(related.path, relatedText, context.sourceHashes) === related.contentHash;
		}))) continue;
		const liveUnit = locateRepoMapUnit(candidate, units, query.query, context);
		if (liveUnit === undefined) continue;
		const matchLines = query.match === "auto" ? [] : strictMatchLines(liveUnit, text, query.query, query.match, regex);
		if (query.match !== "auto" && matchLines.length === 0) continue;
		const repoReasons = cachedRepoMapReasons(context, candidate);
		const reasons = query.match === "auto"
			? repoReasons
			: [query.match === "regex" ? "regex" : "exact literal", ...repoReasons];
		const region: RankedGrepRegion = {
			id: liveUnit.id,
			path: liveUnit.path,
			kind: liveUnit.kind,
			startLine: liveUnit.startLine,
			endLine: liveUnit.endLine,
			startByte: liveUnit.startByte,
			endByte: liveUnit.endByte,
			...(liveUnit.qualifiedName ?? liveUnit.name ? { symbol: liveUnit.qualifiedName ?? liveUnit.name } : {}),
			...(liveUnit.signature !== undefined ? { signature: liveUnit.signature } : {}),
			tier: repoMapGrepTier(candidate, query.match, liveUnit, query.query, regex),
			evidence: EMPTY_RANKING_EVIDENCE,
			reasons: [...new Set(reasons)],
			matchLines,
			unit: liveUnit,
			callees: candidate.reasons.includes("caller") ? liveUnit.calls.slice(0, 6) : [],
			imports: candidate.reasons.includes("import") ? liveUnit.imports.slice(0, 4) : [],
			repoMap: true,
			lexicalRelevance: 0,
			pathRelevance: 0,
		};
		context.repoMapRegions.set(candidate, region);
		result.push(region);
		sourceByRegion.set(region, candidate);
	}
	for (const [index, region] of result.entries()) {
		const candidate = sourceByRegion.get(region);
		region.evidence = candidate === undefined ? EMPTY_RANKING_EVIDENCE : repoMapRankingEvidence(candidate, index + 1, true);
	}
	return result;
}

function repoMapRelatedRegionsFromCandidates(
	candidates: RepoMapQueryCandidate[],
	sourceText: ReadonlyMap<string, string>,
	context: GrepRankingContext,
	mainPaths: ReadonlySet<string>,
	query: Pick<NormalizedGrepParams, "query" | "match">,
	regex: RegExp | undefined,
): RepoMapRelatedResult[] {
	const byId = new Map<string, { result: RepoMapRelatedResult; order: number }>();
	for (const [order, candidate] of candidates.entries()) {
		const requestedAsMain = query.match === "auto" && isRepoMapMainCandidate(candidate, query.query);
		const relation = repoMapNavigationRelation(candidate);
		if (!isRepoMapNavigationCandidate(candidate) || relation === undefined) continue;
		const text = sourceText.get(candidate.path);
		if (text === undefined || candidate.contentHash === undefined) continue;
		if (sourceHash(candidate.path, text, context.sourceHashes) !== candidate.contentHash) continue;
		const units = cachedUnitsForPath(context, candidate.path, text);
		const unit = locateRepoMapUnit(candidate, units, query.query, context);
		if (requestedAsMain && unit !== undefined) continue;
		if (unit !== undefined && query.match !== "auto" && mainPaths.has(unit.path)
			&& strictMatchLines(unit, text, query.query, query.match, regex).length > 0) continue;
		const identity = unit?.id ?? `file:${candidate.path}`;
		const existing = byId.get(identity);
		if (existing !== undefined) {
			if (existing.result.relations.length < 2 && !existing.result.relations.includes(relation)) existing.result.relations.push(relation);
			existing.order = Math.min(existing.order, order);
			continue;
		}
		byId.set(identity, {
			result: {
				path: candidate.path,
				kind: unit?.kind ?? "file",
				...(unit !== undefined ? { start_line: unit.startLine, end_line: unit.endLine } : {}),
				...(unit?.qualifiedName ?? unit?.name ? { symbol: unit.qualifiedName ?? unit.name } : {}),
				...(unit?.signature !== undefined ? { signature: unit.signature } : {}),
				source: "repo-map",
				relations: [relation],
				query_match: "not_guaranteed",
			},
			order,
		});
	}
	return [...byId.values()]
		.sort((left, right) => left.order - right.order || compareStableString(left.result.path, right.result.path) || (left.result.start_line ?? 0) - (right.result.start_line ?? 0))
		.slice(0, GREP_RELATED_LIMIT)
		.map((item) => item.result);
}

function strictMatchLines(
	unit: IndexedCodeUnit,
	text: string,
	query: string,
	match: Exclude<GrepMatchMode, "auto">,
	regex: RegExp | undefined,
): number[] {
	const content = extractByteRange(text, unit.startByte, unit.endByte);
	const result: number[] = [];
	for (const [index, line] of content.split(/\n/u).entries()) {
		const matched = match === "literal" ? line.includes(query) : regex?.test(line) === true;
		if (regex !== undefined) regex.lastIndex = 0;
		if (matched) result.push(unit.startLine + index);
	}
	return result;
}

function repoMapReasons(candidate: RepoMapQueryCandidate): string[] {
	const primary = primaryRepoMapReason(candidate);
	const reasons = [primary];
	if (candidate.hop > 0) reasons.push(`hop ${candidate.hop}`);
	return reasons;
}

function primaryRepoMapReason(candidate: RepoMapQueryCandidate): string {
	const relation = (["caller", "callee", "reference", "import", "test", "mock", "fixture", "snapshot"] as const)
		.find((reason) => candidate.hop > 0 && candidate.reasons.includes(reason));
	if (relation !== undefined) return relation;
	if (candidate.reasons.includes("alias")) return formatRepoMapAliasReason(candidate);
	for (const reason of [
		"exact qualified symbol", "exact symbol", "short symbol", "registration", "entrypoint", "public api", "definition", "export",
		"signature", "exact path", "exact filename", "path match", "component", "package", "test config",
	] as const) {
		if (!candidate.reasons.includes(reason)) continue;
		if (reason === "short symbol") return "exact symbol";
		if (reason === "signature") return "symbol signature";
		return reason;
	}
	return candidate.reasons[0] ?? "related";
}

function cachedRepoMapReasons(context: GrepRankingContext, candidate: RepoMapQueryCandidate): string[] {
	const cached = context.repoMapReasons.get(candidate);
	if (cached !== undefined) return cached;
	const reasons = repoMapReasons(candidate);
	context.repoMapReasons.set(candidate, reasons);
	return reasons;
}

function cachedUnitsForPath(context: GrepRankingContext, filePath: string, text: string): IndexedCodeUnit[] {
	const cached = context.unitsByPath.get(filePath);
	if (cached !== undefined) return cached;
	const units = parseCodeUnits(filePath, text).units;
	context.unitsByPath.set(filePath, units);
	context.unitsByIdByPath.set(filePath, new Map(units.map((unit) => [unit.id, unit])));
	return units;
}

function cachedUnitById(context: GrepRankingContext, filePath: string, unitId: string): IndexedCodeUnit | undefined {
	let byId = context.unitsByIdByPath.get(filePath);
	if (byId === undefined) {
		const units = context.unitsByPath.get(filePath);
		if (units === undefined) return undefined;
		byId = new Map(units.map((unit) => [unit.id, unit]));
		context.unitsByIdByPath.set(filePath, byId);
	}
	return byId.get(unitId);
}

function locateRepoMapUnit(
	candidate: RepoMapQueryCandidate,
	units: readonly IndexedCodeUnit[],
	query: string,
	context: GrepRankingContext,
): IndexedCodeUnit | undefined {
	if (candidate.symbol !== undefined) {
		const exact = cachedUnitById(context, candidate.path, candidate.symbol.id);
		if (exact !== undefined) return exact;
	}
	const range = candidate.symbol?.range ?? candidate.range;
	if (range !== undefined) {
		const containing = units
			.filter((unit) => unit.startByte <= range.endByte && range.startByte <= unit.endByte)
			.sort((left, right) => rangeDistance(left, range) - rangeDistance(right, range)
				|| (left.endByte - left.startByte) - (right.endByte - right.startByte))[0];
		if (containing !== undefined) return containing;
	}
	const names = [
		candidate.symbol?.qualifiedName,
		candidate.symbol?.name,
		...candidate.matchedAliases.flatMap((alias) => [alias.term, alias.canonical]),
	].filter((value): value is string => value !== undefined).map(normalizeSymbol);
	for (const unit of units) {
		const unitNames = [unit.qualifiedName, unit.name, ...unit.definitions]
			.filter((value): value is string => value !== undefined)
			.map(normalizeSymbol);
		if (names.some((name) => unitNames.includes(name))) return unit;
	}
	const tokens = symbolTokens(query);
	let best: IndexedCodeUnit | undefined;
	let bestScore = 0;
	for (const unit of units) {
		const haystack = symbolTokens([unit.qualifiedName, unit.name, unit.signature].filter(Boolean).join(" "));
		let score = 0;
		for (const token of tokens) if (haystack.includes(token)) score += 1;
		if (score > bestScore) {
			best = unit;
			bestScore = score;
		}
	}
	return bestScore > 0 ? best : undefined;
}

function rangeDistance(unit: IndexedCodeUnit, range: { startByte: number; endByte: number }): number {
	return Math.abs(unit.startByte - range.startByte) + Math.abs(unit.endByte - range.endByte);
}

function normalizeSymbol(value: string): string {
	return value.replace(/\s+/gu, "").toLocaleLowerCase();
}

function symbolTokens(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.toLocaleLowerCase()
		.split(/[^a-z0-9_$]+/u)
		.filter((token) => token.length > 0);
}

function lspTier(candidate: FileToolLspSymbolCandidate, query: string): number {
	if (candidate.origin === "reference" || candidate.reason === "lsp reference") return 6;
	const symbol = candidate.symbol.toLocaleLowerCase();
	const normalizedQuery = query.toLocaleLowerCase();
	if (symbol === normalizedQuery && /[.#]/u.test(query)) return 1;
	if (symbol === normalizedQuery || symbol.split(/[.#]/u).at(-1) === normalizedQuery) return 3;
	if (symbol.startsWith(normalizedQuery) || symbolTokens(candidate.symbol).includes(normalizedQuery)) return 4;
	return 5;
}

function compareLspCandidates(left: RankedGrepRegion, right: RankedGrepRegion): number {
	return left.tier - right.tier
		|| compareStableString(left.symbol ?? "", right.symbol ?? "")
		|| compareStableString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine;
}

function cachedByteRangeForLines(
	context: GrepRankingContext,
	filePath: string,
	text: string,
	startLine: number,
	endLine: number,
) {
	let lineIndex = context.lineIndexes.get(filePath);
	if (lineIndex === undefined) {
		lineIndex = buildLineIndex(text);
		context.lineIndexes.set(filePath, lineIndex);
	}
	return byteRangeForLinesWithIndex(lineIndex, startLine, endLine);
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function sourceHash(filePath: string, text: string, hashes: Map<string, string>): string {
	const cached = hashes.get(filePath);
	if (cached !== undefined) return cached;
	const hash = hashText(text);
	hashes.set(filePath, hash);
	return hash;
}

function hydrationPaths(regions: RankedGrepRegion[], resultLimit: number): string[] {
	const limit = Math.max(resultLimit * 4, resultLimit + 8);
	return selectGrepCandidatesForPacking(regions, limit).map((region) => region.path);
}

function limitedUniquePaths(paths: string[], limit: number): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const filePath of paths) {
		if (seen.has(filePath)) continue;
		seen.add(filePath);
		result.push(filePath);
		if (result.length >= limit) break;
	}
	return result;
}

async function scanFallbackSourceText(input: {
	sourceText: Map<string, string>;
	files: Array<{ path: string; absolutePath: string }>;
	query: string;
	match: GrepMatchMode;
	regex: RegExp | undefined;
	signal: AbortSignal | undefined;
	runtime: GrepRuntime;
	limit: number;
}): Promise<ToolOutcome<void>> {
	const filesByPath = new Map(input.files.map((file) => [file.path, file]));
	const files = input.files.filter((file) => !input.sourceText.has(file.path));
	let loaded = 0;
	for (let offset = 0; offset < files.length; offset += SOURCE_READ_CONCURRENCY) {
		if (loaded >= input.limit) return;
		const batch = files.slice(offset, offset + SOURCE_READ_CONCURRENCY);
		const matches = await Promise.all(batch.map(async (file) => ({
			file,
			matched: await fileHasLineMatch(file, input.query, input.match, input.regex, input.signal),
		})));
		const matchedPaths: string[] = [];
		for (const { file, matched } of matches) {
			if (isFailed(matched)) {
				if (matched.error.code === "OPERATION_ABORTED") return matched;
				continue;
			}
			if (matched) matchedPaths.push(file.path);
		}
		const selected = matchedPaths.slice(0, input.limit - loaded);
		const source = await loadCandidateSourceText(input.sourceText, filesByPath, selected, input.signal, input.runtime);
		if (isFailed(source)) return source;
		loaded += selected.length;
	}
}

async function fileHasLineMatch(
	file: { path: string; absolutePath: string },
	query: string,
	match: GrepMatchMode,
	regex: RegExp | undefined,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome<boolean>> {
	const matcher = regex === undefined ? undefined : new RegExp(regex.source, regex.flags);
	const stream = createReadStream(file.absolutePath, { encoding: "utf8", signal });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (signal?.aborted) return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
			if (match === "regex") {
				if (matcher?.test(line) === true) {
					if (matcher.global) matcher.lastIndex = 0;
					return true;
				}
				if (matcher?.global === true) matcher.lastIndex = 0;
			} else if (line.includes(query)) {
				return true;
			}
		}
		return false;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
		return fail("FILE_NOT_FOUND", "File cannot be read.", { path: file.path });
	} finally {
		lines.close();
		stream.destroy();
	}
}

function repoMapGrepTier(
	candidate: RepoMapQueryCandidate,
	match: GrepMatchMode,
	unit: IndexedCodeUnit,
	query: string,
	regex: RegExp | undefined,
): number {
	if (match !== "auto") {
		const values = [unit.name, unit.qualifiedName, unit.signature].filter((value): value is string => value !== undefined);
		const direct = match === "regex"
			? values.some((value) => regexMatchesValue(value, regex))
			: values.some((value) => value.includes(query));
		return direct ? 0 : 1;
	}
	if (candidate.hop === 0 && candidate.reasons.includes("exact qualified symbol")) return 1;
	if (candidate.hop === 0 && (candidate.reasons.includes("exact symbol") || candidate.reasons.includes("short symbol") || candidate.reasons.includes("definition"))) return 3;
	if (candidate.hop === 0) return 5;
	return candidate.hop === 1 ? 6 : 7;
}

function regexMatchesValue(value: string, regex: RegExp | undefined): boolean {
	if (regex === undefined) return false;
	const matched = regex.test(value);
	regex.lastIndex = 0;
	return matched;
}

function looksLikeSymbol(query: string): boolean {
	return /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*$/u.test(query);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
