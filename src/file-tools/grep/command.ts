import { buildLineIndex, byteRangeForLinesWithIndex, extractByteRange, parseCodeUnits, type IndexedCodeUnit, type LineIndex } from "../../code-index/parser.js";
import type { ExistingRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { bindOperationContext } from "../../filesystem/operation-context.js";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.js";
import { createSourceRankingEvidence, EMPTY_RANKING_EVIDENCE } from "../shared/ranking/evidence.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { compareRankedGrepRegions, fuseRankedGrepSources, mergeRankedGrepSources } from "./fusion.js";
import { formatGraphAliasReason, graphNavigationRelation, graphRankingEvidence, isGraphMainCandidate, isGraphNavigationCandidate } from "./graph-ranking.js";
import { hydrateGrepSourceText } from "./hydration.js";
import { GrepIndex, type GrepScopedFile } from "./indexer.js";
import { packGrepResults, renderGrepSuccess, selectGrepCandidatesForPacking } from "./packer.js";
import type { GrepGraphCandidate, GrepGraphSource, GrepSymbolCandidate, GrepSymbolSource } from "./ports.js";
import { rankGrepRegions, type RankedGrepRegion } from "./ranker.js";
import { createQueryPlan, type QueryPlan } from "./query-plan.js";
import type { GrepMatchMode, GrepNearbyResult, GrepParams, GrepRelatedResult, GrepScopeError, GrepSuccess } from "./types.js";

interface GrepScopeResult {
	path: string;
	match: GrepMatchMode;
	totalCandidates: number;
	regions: RankedGrepRegion[];
	sourceText: Map<string, string>;
	scannedFiles: number;
	skipped: GrepScopeIndexStats;
	scanComplete: boolean;
	nearby: GrepNearbyResult[];
	tokenBudget: number;
	resultLimit: number;
	related?: GrepRelatedResult[];
}

type GrepScopeIndexStats = NonNullable<GrepSuccess["stats"]["skipped_files"]>;

interface GrepRankingContext {
	readonly unitsByPath: Map<string, IndexedCodeUnit[]>;
	readonly unitsByIdByPath: Map<string, Map<string, IndexedCodeUnit>>;
	readonly sourceHashes: Map<string, string>;
	readonly lineIndexes: Map<string, LineIndex>;
	readonly graphReasons: WeakMap<GrepGraphCandidate, string[]>;
	readonly symbolRegions: WeakMap<GrepSymbolCandidate, RankedGrepRegion>;
	readonly graphRegions: WeakMap<GrepGraphCandidate, RankedGrepRegion>;
}

export interface GrepCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits,
		"grep_max_entries_traversed" | "grep_max_text_bytes_scanned" | "grep_max_text_file_bytes"
		| "grep_max_files_parsed" | "grep_max_parse_file_bytes" | "grep_output_token_budget" | "grep_result_limit">;
	readonly symbols?: GrepSymbolSource;
	readonly graph?: GrepGraphSource;
}

const GREP_RELATED_TRIGGER = 4;
const GREP_RELATED_LIMIT = 3;

/** Stateful grep command; derived indexes, pending builds, workers, and parsers share this owner. */
export class GrepTool {
	private readonly index = new GrepIndex();
	private readonly owner = new AbortController();
	private disposed = false;

	async execute(params: GrepParams, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		context = { ...context, operation: bindOperationContext(this.owner.signal, context.operation) };
		const validation = createQueryPlan(params);
		if (isFailed(validation)) return validation;
		const regex = validation.regex;

		const scopeErrors: GrepScopeError[] = [];
		const resolved: Array<{ root: ExistingRef; input: string; order: number }> = [];
		for (const [order, input] of validation.paths.entries()) {
			const root = await resolveScope(input, context);
			if (isFailed(root)) scopeErrors.push({ path: input, error: root.error });
			else if (!resolved.some((item) => item.root.displayPath === root.displayPath)) resolved.push({ root, input, order });
		}
		const successes: GrepScopeResult[] = [];
		for (const scope of resolved) {
			if (isAborted(context.operation.signal)) return aborted(scope.root.displayPath);
			const result = await this.grepScope(scope.root, validation, regex, context);
			if (isFailed(result)) scopeErrors.push({ path: scope.input, error: result.error });
			else successes.push(result);
		}
		if (isAborted(context.operation.signal)) return aborted();
		if (successes.length === 0) {
			const first = scopeErrors[0];
			if (first === undefined) return fail("PATH_NOT_FOUND", "No searchable scope was provided.");
			return withGrepScopeErrors({ status: "failed", error: first.error }, [...validation.paths], scopeErrors);
		}
		return mergeScopeSuccesses(validation, successes, scopeErrors);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.owner.abort(new Error("grep is shut down."));
		this.index.dispose();
	}

	private async grepScope(
		root: ExistingRef,
		validation: QueryPlan,
		compiledRegex: RegExp | undefined,
		context: GrepCommandContext,
	): Promise<ToolOutcome<GrepScopeResult>> {
		const index = await this.index.get(root, {
			query: validation.query,
			match: validation.match,
			...(validation.glob === undefined ? {} : { glob: validation.glob }),
		}, context);
		if (isFailed(index)) return index;
		if (isAborted(context.operation.signal)) return aborted(root.displayPath);
		const sourceText = new Map(index.sourceText);
		const filesByPath = new Map<string, GrepScopedFile>(index.scopedFiles.map((file) => [file.path, file]));
		for (const file of index.files) filesByPath.set(file.path, file);
		const rankingContext = createGrepRankingContext(index.files, index.sourceHashes);
		const rankInput = {
			query: validation.query,
			match: validation.match,
			files: index.files.map((file) => ({ path: file.path, units: file.index.units, parserStatus: file.parserStatus })),
			sourceText,
			lineIndexes: rankingContext.lineIndexes,
			allowMetadataCandidates: validation.match !== "auto",
			...(compiledRegex === undefined ? {} : { regex: compiledRegex }),
		};
		const rankedSourceCount = sourceText.size;
		let ranked = rankGrepRegions(rankInput);
		const mainPaths = new Set(index.files.map((file) => file.path));
		const scopePaths = new Set(index.scopedFiles.map((file) => file.path));
		const allowedPaths = index.matchedFiles.map((file) => file.path);
		const graphQuery = graphQueryForGrep(validation);
		const [graphResult, symbolCandidates] = await Promise.all([
			graphQuery === undefined ? Promise.resolve(undefined) : safeGraphCandidates(context.graph, {
				root,
				query: graphQuery,
				limit: validation.match === "auto" ? Math.max(24, context.limits.grep_result_limit * 6) : Math.max(16, context.limits.grep_result_limit * 4),
				...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
			}),
			safeSymbolCandidates(context.symbols, {
				root,
				query: validation.query,
				allowedPaths,
				...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
			}, validation.match),
		]);
		if (isAborted(context.operation.signal)) return aborted(root.displayPath);
		const graphCandidates = graphResult?.candidates.filter((candidate) =>
			(validation.match === "auto" ? mainPaths : scopePaths).has(candidate.path)
			&& (validation.match !== "auto" || candidate.relatedEdges.every((edge) => edge.relatedFiles.every((file) => mainPaths.has(file.path))))) ?? [];
		const graphMainCandidates = graphCandidates.filter((candidate) => mainPaths.has(candidate.path));
		const symbolSourcePaths = limitedUniquePaths(symbolCandidates.map((candidate) => candidate.path), context.limits.grep_result_limit * 4);
		const graphSourcePaths = limitedUniquePaths(
			graphCandidates.flatMap((candidate) => validation.match === "auto"
				? [candidate.path, ...candidate.relatedEdges.flatMap((edge) => edge.relatedFiles.map((file) => file.path))]
				: [candidate.path]),
			context.limits.grep_result_limit * (validation.match === "auto" ? 10 : 4),
		);
		const candidatePaths = limitedUniquePaths(
			[...symbolSourcePaths, ...graphSourcePaths].filter((path) => (filesByPath.get(path)?.size ?? Number.POSITIVE_INFINITY) <= context.limits.grep_max_text_file_bytes),
			symbolSourcePaths.length + graphSourcePaths.length,
		);
		const loadedCandidates = await hydrateGrepSourceText(sourceText, rankingContext.sourceHashes, filesByPath, candidatePaths, {
			filesystem: context.filesystem,
			operation: context.operation,
			maxFileBytes: context.limits.grep_max_text_file_bytes,
		});
		if (isFailed(loadedCandidates)) return loadedCandidates;
		if (isAborted(context.operation.signal)) return aborted(root.displayPath);
		let symbols = symbolRegionsFromCandidates(symbolCandidates, validation.query, validation.match, sourceText, mainPaths, rankingContext);
		let graph = graphRegionsFromCandidates(graphMainCandidates, sourceText, rankingContext, validation, compiledRegex);
		const regions = fuseRankedGrepSources(ranked.regions, symbols, graph);
		const externalRegionSourceCount = sourceText.size;
		const hydrated = await hydrateGrepSourceText(
			sourceText,
			rankingContext.sourceHashes,
			filesByPath,
			hydrationPaths(regions, context.limits.grep_result_limit),
			{ filesystem: context.filesystem, operation: context.operation, maxFileBytes: context.limits.grep_max_text_file_bytes },
		);
		if (isFailed(hydrated)) return hydrated;
		if (isAborted(context.operation.signal)) return aborted(root.displayPath);
		if (sourceText.size !== rankedSourceCount) ranked = rankGrepRegions({ ...rankInput, sourceText, allowMetadataCandidates: false });
		if (sourceText.size !== externalRegionSourceCount) {
			symbols = symbolRegionsFromCandidates(symbolCandidates, validation.query, validation.match, sourceText, mainPaths, rankingContext);
			graph = graphRegionsFromCandidates(graphMainCandidates, sourceText, rankingContext, validation, compiledRegex);
		}
		const finalRegions = fuseRankedGrepSources(ranked.regions, symbols, graph);
		const related = finalRegions.length < GREP_RELATED_TRIGGER
			? await graphRelatedRegionsFromCandidates(graphCandidates, sourceText, rankingContext, mainPaths, validation, compiledRegex)
			: [];
		if (isAborted(context.operation.signal)) return aborted(root.displayPath);
		return {
			path: root.displayPath,
			match: validation.match,
			totalCandidates: finalRegions.length,
			regions: finalRegions,
			sourceText,
			tokenBudget: context.limits.grep_output_token_budget,
			resultLimit: context.limits.grep_result_limit,
			scannedFiles: index.scannedFiles,
			skipped: index.skipped,
			scanComplete: index.scanComplete,
			nearby: finalRegions.length === 0 ? ranked.nearby : [],
			...(related.length === 0 ? {} : { related }),
		};
	}
}

async function resolveScope(input: string, context: GrepCommandContext): Promise<ToolOutcome<ExistingRef>> {
	const resolved = await context.filesystem.paths.resolveExisting(input, { expected: "any", followFinalSymlink: true }, context.operation);
	if (!resolved.ok) return mapFsError(resolved.error, resolved.error.code === "not-found" ? { message: "Path does not exist." } : {});
	if (resolved.value.kind !== "file" && resolved.value.kind !== "directory") {
		return fail("INVALID_PATH", "Path must be a regular file or directory.", { path: resolved.value.displayPath });
	}
	return resolved.value;
}

function mergeScopeSuccesses(
	validation: QueryPlan,
	successes: readonly GrepScopeResult[],
	scopeErrors: GrepScopeError[],
): GrepSuccess {
	const paths = successes.map((result) => result.path);
	const regions = mergeScopeRegions(successes.flatMap((result) => result.regions));
	const sourceText = new Map<string, string>();
	for (const result of successes) for (const [filePath, text] of result.sourceText) sourceText.set(filePath, text);
	const related = regions.length < GREP_RELATED_TRIGGER ? mergeGrepRelated(successes.flatMap((result) => result.related ?? [])) : [];
	const nearby = regions.length === 0 ? mergeGrepNearby(successes.flatMap((result) => result.nearby)) : [];
	const skipped = mergeGrepSkipped(successes.map((result) => result.skipped));
	return packGrepResults({
		query: validation.query,
		path: paths[0] ?? ".",
		paths,
		scopeErrors,
		match: validation.match,
		totalCandidates: regions.length,
		regions,
		sourceText,
		tokenBudget: Math.min(...successes.map((result) => result.tokenBudget)),
		resultLimit: Math.min(...successes.map((result) => result.resultLimit)),
		scannedFiles: successes.reduce((sum, result) => sum + result.scannedFiles, 0),
		...(Object.keys(skipped).length === 0 ? {} : { skipped }),
		scanComplete: successes.every((result) => result.scanComplete),
		nearby,
		...(related.length === 0 ? {} : { related }),
	});
}

function createGrepRankingContext(
	files: Array<{ path: string; index: { units: IndexedCodeUnit[] } }>,
	sourceHashes: ReadonlyMap<string, string>,
): GrepRankingContext {
	const unitsByPath = new Map<string, IndexedCodeUnit[]>();
	for (const file of files) unitsByPath.set(file.path, file.index.units);
	return {
		unitsByPath,
		unitsByIdByPath: new Map(),
		sourceHashes: new Map(sourceHashes),
		lineIndexes: new Map(),
		graphReasons: new WeakMap(),
		symbolRegions: new WeakMap(),
		graphRegions: new WeakMap(),
	};
}

export function formatCompactGrepResult(result: GrepSuccess): string {
	return renderGrepSuccess(result);
}

function mergeScopeRegions(regions: RankedGrepRegion[]): RankedGrepRegion[] {
	return mergeRankedGrepSources([], regions).sort(compareRankedGrepRegions);
}

function mergeGrepRelated(results: GrepRelatedResult[]): GrepRelatedResult[] {
	const merged = new Map<string, GrepRelatedResult>();
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

/** regex 仅用最长字面标识片段召回图候选；严格验证仍使用原表达式。 */
function graphQueryForGrep(params: Pick<QueryPlan, "query" | "match">): string | undefined {
	if (params.match !== "regex") return params.query;
	return params.query.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/gu)
		?.sort((left, right) => right.length - left.length || compareStableString(left, right))[0];
}

async function safeGraphCandidates(
	source: GrepGraphSource | undefined,
	input: Parameters<GrepGraphSource["query"]>[0],
): Promise<Awaited<ReturnType<GrepGraphSource["query"]>>> {
	if (source === undefined) return undefined;
	try { return await source.query(input); } catch { return undefined; }
}

async function safeSymbolCandidates(
	source: GrepSymbolSource | undefined,
	input: Parameters<GrepSymbolSource["query"]>[0],
	match: GrepMatchMode,
): Promise<readonly GrepSymbolCandidate[]> {
	if (source === undefined || match !== "auto" || !looksLikeSymbol(input.query)) return [];
	try { return await source.query(input); } catch { return []; }
}

function symbolRegionsFromCandidates(
	candidates: readonly GrepSymbolCandidate[],
	query: string,
	match: GrepMatchMode,
	sourceText: Map<string, string>,
	allowedPaths: Set<string>,
	context: GrepRankingContext,
): RankedGrepRegion[] {
	if (match !== "auto") return [];
	const ranked: RankedGrepRegion[] = [];
	const sourceByRegion = new Map<RankedGrepRegion, GrepSymbolCandidate>();
	for (const candidate of candidates) {
		if (!allowedPaths.has(candidate.path)) continue;
		const text = sourceText.get(candidate.path);
		if (text === undefined) continue;
		const cached = context.symbolRegions.get(candidate);
		if (cached !== undefined) {
			ranked.push(cached);
			sourceByRegion.set(cached, candidate);
			continue;
		}
		const range = cachedByteRangeForLines(context, candidate.path, text, candidate.startLine, candidate.endLine);
		const region: RankedGrepRegion = {
			id: `${candidate.path}:${range.startByte}:${range.endByte}:lsp:${candidate.symbol}`,
			path: candidate.path,
			kind: candidate.kind,
			startLine: candidate.startLine,
			endLine: candidate.endLine,
			startByte: range.startByte,
			endByte: range.endByte,
			symbol: candidate.symbol,
			...(candidate.signature !== undefined ? { signature: candidate.signature } : {}),
			tier: lspTier(candidate, query),
			evidence: EMPTY_RANKING_EVIDENCE,
			reasons: [candidate.reason],
			matchLines: [candidate.startLine],
			callees: [],
			imports: [],
			lexicalRelevance: 0,
			pathRelevance: 0,
		};
		context.symbolRegions.set(candidate, region);
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

function graphRegionsFromCandidates(
	candidates: readonly GrepGraphCandidate[],
	sourceText: ReadonlyMap<string, string>,
	context: GrepRankingContext,
	query: Pick<QueryPlan, "query" | "match">,
	regex: RegExp | undefined,
): RankedGrepRegion[] {
	const result: RankedGrepRegion[] = [];
	const sourceByRegion = new Map<RankedGrepRegion, GrepGraphCandidate>();
	for (const candidate of candidates) {
		if (!isGraphMainCandidate(candidate, query.query)) continue;
		const cached = context.graphRegions.get(candidate);
		if (cached !== undefined) {
			result.push(cached);
			sourceByRegion.set(cached, candidate);
			continue;
		}
		const text = sourceText.get(candidate.path);
		const units = context.unitsByPath.get(candidate.path);
		if (units === undefined || text === undefined || candidate.contentHash === undefined) continue;
		if (!matchesContentHash(sourceHash(candidate.path, text, context.sourceHashes), candidate.contentHash)) continue;
		if (query.match === "auto" && !candidate.relatedEdges.every((edge) => edge.relatedFiles.every((related) => {
			const relatedText = sourceText.get(related.path);
			return related.contentHash !== undefined
				&& relatedText !== undefined
				&& matchesContentHash(sourceHash(related.path, relatedText, context.sourceHashes), related.contentHash);
		}))) continue;
		const liveUnit = locateRepoMapUnit(candidate, units, query.query, context);
		if (liveUnit === undefined) continue;
		const matchLines = query.match === "auto" ? [] : strictMatchLines(liveUnit, text, query.query, query.match, regex);
		if (query.match !== "auto" && matchLines.length === 0) continue;
		const repoReasons = cachedGraphReasons(context, candidate);
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
			imports: [],
			repoMap: true,
			lexicalRelevance: 0,
			pathRelevance: 0,
		};
		context.graphRegions.set(candidate, region);
		result.push(region);
		sourceByRegion.set(region, candidate);
	}
	for (const [index, region] of result.entries()) {
		const candidate = sourceByRegion.get(region);
		region.evidence = candidate === undefined ? EMPTY_RANKING_EVIDENCE : graphRankingEvidence(candidate, index + 1);
	}
	return result;
}

async function graphRelatedRegionsFromCandidates(
	candidates: readonly GrepGraphCandidate[],
	sourceText: ReadonlyMap<string, string>,
	context: GrepRankingContext,
	mainPaths: ReadonlySet<string>,
	query: Pick<QueryPlan, "query" | "match">,
	regex: RegExp | undefined,
): Promise<GrepRelatedResult[]> {
	const byId = new Map<string, { result: GrepRelatedResult; order: number }>();
	for (const [order, candidate] of candidates.entries()) {
		const requestedAsMain = query.match === "auto" && isGraphMainCandidate(candidate, query.query);
		const relation = graphNavigationRelation(candidate);
		if (!isGraphNavigationCandidate(candidate) || relation === undefined) continue;
		const text = sourceText.get(candidate.path);
		if (text === undefined || candidate.contentHash === undefined) continue;
		if (!matchesContentHash(sourceHash(candidate.path, text, context.sourceHashes), candidate.contentHash)) continue;
		const units = await cachedUnitsForPath(context, candidate.path, text);
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
				sources: ["repo-map"],
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

function graphReasons(candidate: GrepGraphCandidate): string[] {
	const primary = primaryRepoMapReason(candidate);
	const reasons = [primary];
	if (candidate.hop > 0) reasons.push(`hop ${candidate.hop}`);
	return reasons;
}

function primaryRepoMapReason(candidate: GrepGraphCandidate): string {
	const relation = (["caller", "callee", "reference", "import", "test", "mock", "fixture", "snapshot"] as const)
		.find((reason) => candidate.hop > 0 && candidate.reasons.includes(reason));
	if (relation !== undefined) return relation;
	if (candidate.reasons.includes("alias")) return formatGraphAliasReason(candidate);
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

function cachedGraphReasons(context: GrepRankingContext, candidate: GrepGraphCandidate): string[] {
	const cached = context.graphReasons.get(candidate);
	if (cached !== undefined) return cached;
	const reasons = graphReasons(candidate);
	context.graphReasons.set(candidate, reasons);
	return reasons;
}

async function cachedUnitsForPath(context: GrepRankingContext, filePath: string, text: string): Promise<IndexedCodeUnit[]> {
	const cached = context.unitsByPath.get(filePath);
	if (cached !== undefined) return cached;
	const units = (await parseCodeUnits(filePath, text)).units;
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
	candidate: GrepGraphCandidate,
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

function lspTier(candidate: GrepSymbolCandidate, query: string): number {
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

function sourceHash(filePath: string, _text: string, hashes: Map<string, string>): string | undefined {
	return hashes.get(filePath);
}

function matchesContentHash(actual: string | undefined, expected: string): boolean {
	return actual === expected || actual === `sha256:${expected}`;
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

function repoMapGrepTier(
	candidate: GrepGraphCandidate,
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

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", { ...(path === undefined ? {} : { path }) });
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
