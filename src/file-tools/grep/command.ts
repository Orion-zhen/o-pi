import { languageFromPath } from "../../code-index/parser.js";
import type {
	AnalyzeCode,
	CodeAnalysis,
	CodeAnalysisTarget,
	PrepareCodeAnalysis,
} from "../../code-index/types.js";
import type { TextContent } from "../../filesystem/contracts/content.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { bindOperationContext } from "../../filesystem/operation-context.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { fail, isFailed, type FailedResult, type ToolOutcome } from "../shared/result.js";
import { GrepContentCache, type GrepContentCacheLease } from "./content-cache.js";
import { buildScopeInventory, type ScopeInventory } from "./inventory.js";
import { buildRankedRegions, semanticParsePriority } from "./local.js";
import { packGrepResults, renderGrepSuccess } from "./packer.js";
import { createQueryPlan, type QueryPlan } from "./query-plan.js";
import { mergeGrepSkippedFiles } from "./skipped.js";
import {
	GrepRegionizer,
	regionizeAnalyzedFiles,
	type RegionizationResult,
	type RegionizedFile,
} from "./regionizer.js";
import { scanInventoryText, type TextScanResult } from "./text-scanner.js";
import type { GrepParams, GrepScopeError, GrepStats, GrepSuccess } from "./types.js";

type GrepSkippedStats = NonNullable<GrepSuccess["stats"]["skipped_files"]>;

interface SymbolAnalysisAttempt {
	readonly loaded: ReadonlyMap<string, TextContent>;
	readonly result?: RegionizationResult;
}

export interface GrepCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits,
		"grep_max_depth" | "grep_max_entries" | "grep_max_search_bytes" | "grep_ast_max_file_bytes" | "grep_content_cache_bytes" | "grep_content_cache_entries" | "grep_result_limit" | "grep_related_result_limit" | "grep_regional_display_limit">;
	readonly prepareCodeAnalysis?: PrepareCodeAnalysis;
	readonly analyzeCode?: AnalyzeCode;
}

/** Stateful grep command；正文/AST cache、parser 与 active invocation 共享 owner。 */
export class GrepTool {
	private readonly contentCache = new GrepContentCache();
	private readonly regionizer = new GrepRegionizer();
	private readonly owner = new AbortController();
	private disposed = false;

	async execute(params: GrepParams, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		if (!isCacheLimit(context.limits.grep_content_cache_bytes) || !isCacheLimit(context.limits.grep_content_cache_entries)) {
			return fail("INVALID_OPERATION", "grep content cache limits must be non-negative safe integers.");
		}
		if (!isCacheLimit(context.limits.grep_max_search_bytes)) {
			return fail("INVALID_OPERATION", "grep search byte limit must be a non-negative safe integer.");
		}
		const invocation = new AbortController();
		const contentCache = this.contentCache.acquire(
			context.limits.grep_content_cache_bytes,
			context.limits.grep_content_cache_entries,
		);
		context = {
			...context,
			operation: bindOperationContext(invocation.signal, bindOperationContext(this.owner.signal, context.operation)),
		};
		try {
			const plan = createQueryPlan(params);
			if (isFailed(plan)) return plan;
			return await this.grep(plan, context, contentCache);
		} finally {
			contentCache.dispose();
			invocation.abort(new Error("grep invocation completed."));
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.owner.abort(new Error("grep is shut down."));
		this.contentCache.dispose();
		this.regionizer.dispose();
	}

	private async grep(
		plan: QueryPlan,
		context: GrepCommandContext,
		contentCache: GrepContentCacheLease,
	): Promise<ToolOutcome<GrepSuccess>> {
		const inventory = await buildScopeInventory({
			paths: plan.paths,
			...(plan.glob === undefined ? {} : { glob: plan.glob }),
		}, {
			filesystem: context.filesystem,
			operation: context.operation,
			maxDepth: context.limits.grep_max_depth,
			maxEntries: context.limits.grep_max_entries,
		});
		if (isFailed(inventory)) return inventory;
		const searchableInventory = limitInventoryBytes(inventory, context.limits.grep_max_search_bytes);
		const preparation = prepareCodeAnalysis(searchableInventory, context);
		const scanned = await scanInventoryText(searchableInventory, plan, {
			filesystem: context.filesystem,
			operation: context.operation,
			retainTextMaxBytes: context.limits.grep_ast_max_file_bytes,
			contentCache,
		});
		if (isFailed(scanned)) return scanned;
		await preparation;
		if (plan.queryMode === "literal_fallback" && scanned.totalHits === 0) return plan.invalidRegex;
		const analysisPaths = semanticParsePriority(searchableInventory, scanned);
		const analyzed = await analyzeSymbols(plan, searchableInventory, scanned, analysisPaths, context);
		if (isFailed(analyzed)) return analyzed;
		const regionized = analyzed.result ?? await this.regionizer.regionize(
			searchableInventory,
			scanned.hits,
			analysisPaths,
			{
				filesystem: context.filesystem,
				operation: context.operation,
				astMaxFileBytes: context.limits.grep_ast_max_file_bytes,
				preloaded: analyzed.loaded,
			},
		);
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, searchableInventory, scanned.scopeErrors, regionized.scopeErrors);
		if (scope.failure !== undefined) return scope.failure;
		const regions = buildRankedRegions(plan, scanned, regionized, context.limits.grep_regional_display_limit);
		return packGrepResults({
			query: plan.query,
			queryMode: plan.queryMode,
			path: scope.paths[0] ?? ".",
			paths: scope.paths,
			...(scope.errors.length === 0 ? {} : { scopeErrors: scope.errors }),
			regions,
			stats: grepStats(
				searchableInventory,
				scanned.stats,
				scanned.totalHits,
				regionized.files.length,
				regionized.astSkippedOversizedFiles,
				regionized.skipped,
			),
			truncationReasons: searchableInventory.truncationReasons,
			resultLimit: context.limits.grep_result_limit,
			relatedResultLimit: context.limits.grep_related_result_limit,
			regionalDisplayLimit: context.limits.grep_regional_display_limit,
		});
	}
}

function limitInventoryBytes(inventory: ScopeInventory, maxBytes: number): ScopeInventory {
	let selected = 0;
	let reservedBytes = 0;
	for (const file of inventory.files) {
		if (file.snapshot.sizeBytes > maxBytes - reservedBytes) {
			return {
				...inventory,
				files: inventory.files.slice(0, selected),
				truncationReasons: [...inventory.truncationReasons, "byte_limit"],
			};
		}
		reservedBytes += file.snapshot.sizeBytes;
		selected += 1;
	}
	return inventory;
}

function prepareCodeAnalysis(inventory: ScopeInventory, context: GrepCommandContext): Promise<void> {
	if (context.prepareCodeAnalysis === undefined || context.analyzeCode === undefined) return Promise.resolve();
	const paths = inventory.files.flatMap((file) =>
		file.snapshot.sizeBytes <= context.limits.grep_ast_max_file_bytes
			&& languageFromPath(file.path) !== "text"
			? [file.path]
			: []);
	if (paths.length === 0) return Promise.resolve();
	return context.prepareCodeAnalysis({
		paths,
		...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
	}).catch(() => undefined);
}

async function analyzeSymbols(
	plan: QueryPlan,
	inventory: ScopeInventory,
	scan: TextScanResult,
	analysisPaths: readonly string[],
	context: GrepCommandContext,
): Promise<SymbolAnalysisAttempt | FailedResult> {
	const loaded = new Map<string, TextContent>(scan.contents);
	if (context.analyzeCode === undefined) return { loaded };
	const byPath = new Map(inventory.files.map((file) => [file.path, file]));
	const targets = codeAnalysisTargets(scan, analysisPaths, byPath, context.limits.grep_ast_max_file_bytes);
	let analysis;
	try {
		analysis = await context.analyzeCode({
			query: plan.targetQuery.length === 0 ? plan.query : plan.targetQuery,
			targets,
			allowRelated: scan.totalHits === 0,
			limit: context.limits.grep_result_limit,
			async load(path) {
				const cached = loaded.get(path);
				if (cached !== undefined) {
					return hasBareCr(cached.text) ? undefined : { path, text: cached.text, hash: cached.hash };
				}
				const file = byPath.get(path);
				if (file === undefined || file.snapshot.sizeBytes > context.limits.grep_ast_max_file_bytes) return undefined;
				const content = await context.filesystem.content.readText(file.ref, {
					maxBytes: context.limits.grep_ast_max_file_bytes,
					expectedSnapshot: file.snapshot,
					stable: true,
					rejectBinary: true,
				}, context.operation);
				if (!content.ok) return undefined;
				loaded.set(path, content.value);
				if (hasBareCr(content.value.text)) return undefined;
				return { path, text: content.value.text, hash: content.value.hash };
			},
			...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
		});
	} catch {
		return context.operation.signal?.aborted === true ? aborted() : { loaded };
	}
	if (context.operation.signal?.aborted === true) return aborted();
	if (analysis === undefined || !completeCodeAnalysis(analysis, targets, loaded)) return { loaded };
	const files: RegionizedFile[] = analysis.files.flatMap(({ document, analysis: fileAnalysis }) => {
		const file = byPath.get(document.path);
		const content = loaded.get(document.path);
		return file === undefined || content === undefined || fileAnalysis.status !== "parsed"
			? []
			: [{ file, content, analysis: fileAnalysis }];
	});
	return {
		loaded,
		result: {
			regions: regionizeAnalyzedFiles(scan.hits, files, scan.totalHits === 0),
			files,
			astSkippedOversizedFiles: structuralOversizedCount(
				analysisPaths,
				byPath,
				context.limits.grep_ast_max_file_bytes,
			),
			skipped: {},
			scopeErrors: [],
		},
	};
}

function structuralOversizedCount(
	analysisPaths: readonly string[],
	files: ReadonlyMap<string, ScopeInventory["files"][number]>,
	astMaxFileBytes: number,
): number {
	return analysisPaths.filter((path) => {
		const file = files.get(path);
		return file !== undefined
			&& languageFromPath(file.path) !== "text"
			&& file.snapshot.sizeBytes > astMaxFileBytes;
	}).length;
}

function codeAnalysisTargets(
	scan: TextScanResult,
	analysisPaths: readonly string[],
	files: ReadonlyMap<string, ScopeInventory["files"][number]>,
	astMaxFileBytes: number,
): CodeAnalysisTarget[] {
	const ranges = new Map<string, Array<{ startByte: number; endByte: number }>>();
	for (const hit of scan.hits) {
		const grouped = ranges.get(hit.path);
		const range = { startByte: hit.byteStart, endByte: hit.byteEnd };
		if (grouped === undefined) ranges.set(hit.path, [range]);
		else grouped.push(range);
	}
	const paths = scan.totalHits === 0
		? analysisPaths
		: [...ranges.keys()];
	return paths.flatMap((path) => {
		const file = files.get(path);
		if (
			file === undefined
			|| file.snapshot.sizeBytes > astMaxFileBytes
			|| languageFromPath(file.path) === "text"
		) return [];
		return [{ path, ranges: ranges.get(path) ?? [] }];
	});
}

function completeCodeAnalysis(
	analysis: CodeAnalysis,
	targets: readonly CodeAnalysisTarget[],
	loaded: ReadonlyMap<string, TextContent>,
): boolean {
	if (!sameUniquePaths(analysis.coveredPaths, targets.map((target) => target.path))) return false;
	const covered = new Set(analysis.coveredPaths);
	const seen = new Set<string>();
	for (const file of analysis.files) {
		const path = file.document.path;
		const content = loaded.get(path);
		if (
			seen.has(path)
			|| !covered.has(path)
			|| content === undefined
			|| file.document.hash !== content.hash
			|| file.analysis.status !== "parsed"
			|| file.analysis.index.path !== path
			|| file.analysis.index.units.some((unit) =>
				unit.path !== path
				|| unit.startByte < 0
				|| unit.endByte < unit.startByte
				|| unit.endByte > content.sizeBytes)
		) return false;
		seen.add(path);
	}
	return true;
}

function sameUniquePaths(left: readonly string[], right: readonly string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== left.length || rightSet.size !== right.length || leftSet.size !== rightSet.size) return false;
	for (const path of leftSet) if (!rightSet.has(path)) return false;
	return true;
}

function hasBareCr(text: string): boolean {
	return /\r(?!\n)/u.test(text);
}

function successfulScopeState(
	plan: QueryPlan,
	inventory: ScopeInventory,
	scanErrors: readonly GrepScopeError[],
	regionErrors: readonly GrepScopeError[],
): { readonly paths: string[]; readonly errors: GrepScopeError[]; readonly failure?: FailedResult } {
	const errors = [...inventory.scopeErrors, ...scanErrors, ...regionErrors];
	const failedScopes = new Set([...scanErrors, ...regionErrors].map((item) => item.path));
	const paths = uniqueStrings(inventory.scopes.filter((scope) => !failedScopes.has(scope.input)).map((scope) => scope.root.displayPath));
	if (paths.length > 0 || errors.length === 0) return { paths, errors };
	const first = errors[0];
	if (first === undefined) return { paths, errors };
	return { paths, errors, failure: withGrepScopeErrors({ status: "failed", error: first.error }, [...plan.paths], errors) };
}

function grepStats(
	inventory: ScopeInventory,
	scan: {
		readonly searchedFiles: number;
		readonly searchedBytes: number;
		readonly droppedTextHits: number;
		readonly droppedRelatedAnchors: number;
		readonly skipped: GrepSkippedStats;
	},
	textHits: number,
	parsedFiles: number,
	astSkippedOversizedFiles: number,
	regionSkipped: GrepSkippedStats,
): Omit<GrepStats, "dropped_related_results"> {
	const skipped = mergeGrepSkippedFiles([inventory.skipped, scan.skipped, regionSkipped]);
	return {
		traversed_entries: inventory.traversedEntries,
		searched_files: scan.searchedFiles,
		searched_bytes: scan.searchedBytes,
		text_hits: textHits,
		parsed_files: parsedFiles,
		dropped_text_hits: scan.droppedTextHits,
		dropped_related_anchors: scan.droppedRelatedAnchors,
		ast_skipped_oversized_files: astSkippedOversizedFiles,
		...(Object.keys(skipped).length === 0 ? {} : { skipped_files: skipped }),
	};
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

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export function formatCompactGrepResult(result: GrepSuccess): string {
	return renderGrepSuccess(result);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function isCacheLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", path === undefined ? {} : { path });
}
