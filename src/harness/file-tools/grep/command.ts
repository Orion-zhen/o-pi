import { structureIssues } from "../../code-index/structure.ts";
import { languageFromPath } from "../../syntax-tree/grammars.ts";
import type { AnalyzeCode, PrepareCodeAnalysis } from "../../code-index/types.ts";
import type { FsOperationContext } from "../../filesystem/contracts/result.ts";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.ts";
import { combineOperationContext } from "../shared/operation-context.ts";
import type { FileToolLimits } from "../../file-tool-limits.ts";
import { fail, isFailed, type FailedResult, type ToolOutcome } from "../shared/result.ts";
import { GrepContentCache, type GrepContentCacheLease } from "./content-cache.ts";
import { buildScopeInventory, type ScopeInventory } from "./inventory.ts";
import { buildRankedRegions, semanticParsePriority } from "./local.ts";
import { packGrepResults, renderGrepSuccess } from "./packer.ts";
import { createQueryPlan, type QueryPlan } from "./query-plan.ts";
import { mergeGrepSkippedFiles } from "./skipped.ts";
import { GrepRegionizer } from "./regionizer.ts";
import { analyzeSymbols } from "./symbol-analysis.ts";
import { scanInventoryText } from "./text-scanner.ts";
import type { GrepParams, GrepScopeError, GrepStats, GrepSuccess } from "./types.ts";

type GrepSkippedStats = NonNullable<GrepSuccess["stats"]["skipped_files"]>;

export interface GrepCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits,
		"grep_max_depth" | "grep_max_entries" | "grep_max_search_bytes" | "grep_ast_max_file_bytes" | "grep_content_cache_bytes" | "grep_content_cache_entries" | "grep_result_limit" | "grep_related_result_limit" | "grep_regional_display_limit">;
	readonly prepareCodeAnalysis?: PrepareCodeAnalysis;
	readonly analyzeCode?: AnalyzeCode;
}

/** 正文缓存、语法缓存、解析器和活动调用共享所有者。 */
export class GrepTool {
	private readonly contentCache = new GrepContentCache();
	private readonly regionizer = new GrepRegionizer();
	private readonly owner = new AbortController();
	private disposed = false;

	async execute(params: GrepParams, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		const invocation = new AbortController();
		const contentCache = this.contentCache.acquire(
			context.limits.grep_content_cache_bytes,
			context.limits.grep_content_cache_entries,
		);
		context = {
			...context,
			operation: combineOperationContext(context.operation, this.owner.signal, invocation.signal),
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
			maxSearchBytes: context.limits.grep_max_search_bytes,
		});
		if (isFailed(inventory)) return inventory;
		const preparation = prepareCodeAnalysis(inventory, context);
		const scanned = await scanInventoryText(inventory, plan, {
			filesystem: context.filesystem,
			operation: context.operation,
			retainTextMaxBytes: context.limits.grep_ast_max_file_bytes,
			contentCache,
		});
		if (isFailed(scanned)) return scanned;
		await preparation;
		const analysisPaths = semanticParsePriority(inventory, scanned);
		const analyzed = await analyzeSymbols(plan, inventory, scanned, analysisPaths, context,
			(document, signal) => this.regionizer.syntax(document, context.filesystem, signal ?? context.operation.signal));
		if (isFailed(analyzed)) return analyzed;
		const regionized = await this.regionizer.regionize(
			inventory,
			scanned.hits,
			analyzed.syntaxPaths,
			{
				filesystem: context.filesystem,
				operation: context.operation,
				astMaxFileBytes: context.limits.grep_ast_max_file_bytes,
				preloaded: analyzed.loaded,
				semantic: analyzed.files,
				related: scanned.totalHits === 0,
			},
		);
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, inventory, scanned.scopeErrors, regionized.scopeErrors);
		if (scope.failure !== undefined) return scope.failure;
		const regions = buildRankedRegions(plan, scanned, regionized, context.limits.grep_regional_display_limit);
		return packGrepResults({
			query: plan.query,
			queryMode: plan.queryMode,
			path: scope.paths[0] ?? ".",
			paths: scope.paths,
			...(scope.errors.length === 0 ? {} : { scopeErrors: scope.errors }),
			regions,
			analysis: analyzed.coverage,
			structureIssues: regionized.files.flatMap((file) => structureIssues(file.analysis)),
			stats: grepStats(
				inventory,
				scanned.stats,
				scanned.totalHits,
				regionized.files.length,
				regionized.astSkippedOversizedFiles,
				regionized.skipped,
			),
			truncationReasons: inventory.truncationReasons,
			incomplete: inventory.incomplete,
			resultLimit: context.limits.grep_result_limit,
			relatedResultLimit: context.limits.grep_related_result_limit,
			regionalDisplayLimit: context.limits.grep_regional_display_limit,
		});
	}
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

function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", path === undefined ? {} : { path });
}
