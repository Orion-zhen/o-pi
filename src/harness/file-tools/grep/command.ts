import { structureIssues } from "../../code-index/structure.ts";
import type { AnalyzeCode, PrepareCodeAnalysis } from "../../code-index/types.ts";
import type { FsOperationContext } from "../../filesystem/contracts/result.ts";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.ts";
import type { FileToolLimits } from "../../file-tool-limits.ts";
import type { TokenCounterScope } from "../../token-counter.ts";
import { fail, isFailed, type FailedResult, type ToolOutcome } from "../shared/result.ts";
import { GrepContentCache, type GrepContentCacheLease } from "./content-cache.ts";
import { buildScopeInventory, type ScopeInventory } from "./inventory.ts";
import { buildRankedRegions, semanticParsePriority } from "./local.ts";
import { packGrepResults, renderGrepSuccess } from "./packer.ts";
import { createQueryPlan, type QueryPlan } from "./query-plan.ts";
import { mergeGrepSkippedFiles } from "./skipped.ts";
import { regionize } from "./regionizer.ts";
import { GrepDocuments } from "./documents.ts";
import { GrepSyntax } from "./syntax.ts";
import { analyzeSymbols } from "./symbol-analysis.ts";
import { scanInventoryText } from "./text-scanner.ts";
import type { GrepParams, GrepScopeError, GrepStats, GrepSuccess } from "./types.ts";

type GrepSkippedStats = NonNullable<GrepSuccess["stats"]["skipped_files"]>;

export interface GrepCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly tokenScope?: TokenCounterScope;
	readonly limits: Pick<FileToolLimits,
		"grep_max_depth" | "grep_max_entries" | "grep_max_search_bytes" | "grep_ast_max_file_bytes" | "grep_content_cache_bytes" | "grep_content_cache_entries" | "grep_result_limit" | "grep_related_result_limit" | "grep_regional_display_limit">;
	readonly prepareCodeAnalysis?: PrepareCodeAnalysis;
	readonly analyzeCode?: AnalyzeCode;
}

/** 正文缓存、语法缓存、解析器和活动调用共享所有者。 */
export class GrepTool {
	private readonly contentCache = new GrepContentCache();
	private readonly syntax = new GrepSyntax();
	private readonly owner = new AbortController();
	private disposed = false;

	async execute(params: GrepParams, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (this.disposed || context.operation.signal.aborted) return aborted();
		const invocation = new AbortController();
		const contentCache = this.contentCache.acquire(
			context.limits.grep_content_cache_bytes,
			context.limits.grep_content_cache_entries,
		);
		context = {
			...context,
			operation: { signal: AbortSignal.any([context.operation.signal, this.owner.signal, invocation.signal]) },
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
		this.syntax.dispose();
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
		const documents = new GrepDocuments(inventory, context.filesystem, contentCache,
			context.limits.grep_ast_max_file_bytes, this.syntax, context.operation.signal);
		void prepareCodeAnalysis(inventory, documents, context);
		const scanned = await scanInventoryText(inventory, plan, {
			filesystem: context.filesystem,
			operation: context.operation,
			documents,
		});
		if (isFailed(scanned)) return scanned;
		const analysisFiles = semanticParsePriority(inventory, scanned);
		const analyzed = await analyzeSymbols(plan, documents, scanned, analysisFiles.map((file) => file.path), context);
		if (isFailed(analyzed)) return analyzed;
		const syntaxPaths = new Set(analyzed.syntaxPaths);
		const regionized = await regionize(documents, scanned.hits,
			analysisFiles.filter((file) => syntaxPaths.has(file.path)), analyzed.files, scanned.totalHits === 0, context.operation.signal);
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, inventory, scanned.scopeErrors, regionized.scopeErrors);
		if (isFailed(scope)) return scope;
		const regions = buildRankedRegions(plan, scanned, regionized, context.limits.grep_regional_display_limit);
		return packGrepResults({
			query: plan.query,
			queryMode: plan.queryMode,
			path: scope.paths[0],
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
		}, context.tokenScope);
	}
}

function prepareCodeAnalysis(inventory: ScopeInventory, documents: GrepDocuments, context: GrepCommandContext): Promise<void> {
	if (context.prepareCodeAnalysis === undefined || context.analyzeCode === undefined) return Promise.resolve();
	const paths = inventory.files.filter((file) => documents.eligible(file.path)).map((file) => file.path);
	if (paths.length === 0) return Promise.resolve();
	return context.prepareCodeAnalysis({
		paths,
		signal: context.operation.signal,
	}).catch(() => undefined);
}

function successfulScopeState(
	plan: QueryPlan,
	inventory: ScopeInventory,
	scanErrors: readonly GrepScopeError[],
	regionErrors: readonly GrepScopeError[],
): ToolOutcome<{ readonly paths: [string, ...string[]]; readonly errors: GrepScopeError[] }> {
	const errors = [...inventory.scopeErrors, ...scanErrors, ...regionErrors];
	const failures = new Map([...scanErrors, ...regionErrors].map((item) => [item.path, item.error]));
	const [first, ...rest] = inventory.scopes;
	const firstFailure = failures.get(first.input);
	let result: ToolOutcome<{ paths: [string, ...string[]]; errors: GrepScopeError[] }> = firstFailure === undefined
		? { paths: [first.root.displayPath], errors }
		: withGrepScopeErrors({ status: "failed", error: errors[0]?.error ?? firstFailure }, [...plan.paths], errors);
	for (const scope of rest) {
		if (failures.has(scope.input)) continue;
		if (isFailed(result)) result = { paths: [scope.root.displayPath], errors };
		else if (!result.paths.includes(scope.root.displayPath)) result.paths.push(scope.root.displayPath);
	}
	return result;
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

export function formatCompactGrepResult(result: GrepSuccess): string {
	return renderGrepSuccess(result);
}

function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", path === undefined ? {} : { path });
}
