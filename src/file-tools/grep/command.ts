import type { AnalyzeCode } from "../../code-index/types.js";
import type { TextContent } from "../../filesystem/contracts/content.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { bindOperationContext } from "../../filesystem/operation-context.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { fail, isFailed, type FailedResult, type ToolOutcome } from "../shared/result.js";
import { buildScopeInventory, type ScopeInventory } from "./inventory.js";
import { buildLocalResults, semanticParsePriority } from "./local.js";
import { packGrepResults, renderGrepSuccess } from "./packer.js";
import { GrepParser } from "./parser-pool.js";
import { createQueryPlan, type QueryPlan } from "./query-plan.js";
import {
	GrepRegionizer,
	regionizeAnalyzedFiles,
	type RegionizationResult,
	type RegionizedFile,
} from "./regionizer.js";
import { scanInventoryText, type TextScanResult } from "./text-scanner.js";
import type { GrepParams, GrepScopeError, GrepStats, GrepSuccess } from "./types.js";

type GrepSkippedStats = NonNullable<GrepSuccess["stats"]["skipped_files"]>;

export interface GrepCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits,
		"grep_max_depth" | "grep_ast_max_file_bytes" | "grep_result_limit" | "grep_related_result_limit" | "grep_regional_display_limit">;
	readonly analyzeCode?: AnalyzeCode;
}

/** Stateful grep command; parser、派生 AST cache 与 active invocation 共享 owner。 */
export class GrepTool {
	private readonly parser = new GrepParser();
	private readonly regionizer = new GrepRegionizer(this.parser);
	private readonly owner = new AbortController();
	private disposed = false;

	async execute(params: GrepParams, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		const invocation = new AbortController();
		context = {
			...context,
			operation: bindOperationContext(invocation.signal, bindOperationContext(this.owner.signal, context.operation)),
		};
		try {
			const plan = createQueryPlan(params);
			if (isFailed(plan)) return plan;
			return await this.grep(plan, context);
		} finally {
			invocation.abort(new Error("grep invocation completed."));
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.owner.abort(new Error("grep is shut down."));
		this.regionizer.dispose();
		this.parser.dispose();
	}

	private async grep(plan: QueryPlan, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		const inventory = await this.inventory(plan, context);
		if (isFailed(inventory)) return inventory;
		const scanned = await scanInventoryText(inventory, plan, {
			filesystem: context.filesystem,
			operation: context.operation,
		});
		if (isFailed(scanned)) return scanned;
		if (plan.queryMode === "literal_fallback" && scanned.totalHits === 0) return plan.invalidRegex;
		const analyzed = await analyzeSymbols(plan, inventory, scanned, context);
		if (isFailed(analyzed)) return analyzed;
		const regionized = analyzed ?? await this.regionizer.regionize(
			inventory,
			scanned.hits,
			semanticParsePriority(inventory, scanned),
			{
				filesystem: context.filesystem,
				operation: context.operation,
				astMaxFileBytes: context.limits.grep_ast_max_file_bytes,
			},
		);
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, inventory, scanned.scopeErrors, regionized.scopeErrors);
		if (scope.failure !== undefined) return scope.failure;
		const local = buildLocalResults(plan, scanned, regionized, context.limits.grep_regional_display_limit);
		return packGrepResults({
			query: plan.query,
			queryMode: plan.queryMode,
			path: scope.paths[0] ?? ".",
			paths: scope.paths,
			...(scope.errors.length === 0 ? {} : { scopeErrors: scope.errors }),
			regions: local.ranked,
			stats: grepStats(
				inventory,
				scanned.stats,
				scanned.totalHits,
				regionized.parsedFiles,
				regionized.astSkippedOversizedFiles,
				regionized.skipped,
			),
			truncationReasons: inventory.truncationReasons,
			resultLimit: context.limits.grep_result_limit,
			relatedResultLimit: context.limits.grep_related_result_limit,
			regionalDisplayLimit: context.limits.grep_regional_display_limit,
		});
	}

	private async inventory(plan: QueryPlan, context: GrepCommandContext): Promise<ToolOutcome<ScopeInventory>> {
		return await buildScopeInventory({
			paths: plan.paths,
			...(plan.glob === undefined ? {} : { glob: plan.glob }),
		}, {
			filesystem: context.filesystem,
			operation: context.operation,
			maxDepth: context.limits.grep_max_depth,
		});
	}
}

async function analyzeSymbols(
	plan: QueryPlan,
	inventory: ScopeInventory,
	scan: TextScanResult,
	context: GrepCommandContext,
): Promise<RegionizationResult | undefined | FailedResult> {
	if (
		context.analyzeCode === undefined
		|| (scan.totalHits > 0 && (plan.structuredQuery === undefined || scan.totalHits === 1))
	) return undefined;
	const byPath = new Map(inventory.files.map((file) => [file.path, file]));
	const loaded = new Map<string, TextContent>();
	let analysis;
	try {
		analysis = await context.analyzeCode({
			query: plan.targetQuery.length === 0 ? plan.query : plan.targetQuery,
			allowedPaths: inventory.files.map((file) => file.path),
			allowRelated: scan.totalHits === 0,
			limit: context.limits.grep_result_limit,
			async load(path) {
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
				return { path, text: content.value.text, hash: content.value.hash };
			},
			...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
		});
	} catch {
		return context.operation.signal?.aborted === true ? aborted() : undefined;
	}
	if (context.operation.signal?.aborted === true) return aborted();
	if (analysis === undefined || analysis.files.length === 0) return undefined;
	const files: RegionizedFile[] = analysis.files.flatMap(({ document, analysis: fileAnalysis }) => {
		const file = byPath.get(document.path);
		const content = loaded.get(document.path);
		return file === undefined || content === undefined || fileAnalysis.status !== "parsed"
			? []
			: [{ file, content, analysis: fileAnalysis }];
	});
	return {
		regions: regionizeAnalyzedFiles(scan.hits, files, true),
		files,
		parsedFiles: files.length,
		astSkippedOversizedFiles: 0,
		skipped: {},
		scopeErrors: [],
	};
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
	const skipped = mergeGrepSkipped([inventory.skipped, scan.skipped, regionSkipped]);
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

function mergeGrepSkipped(values: readonly GrepSkippedStats[]): GrepSkippedStats {
	const merged: GrepSkippedStats = {};
	for (const value of values) for (const [key, count] of Object.entries(value)) {
		if (count === undefined) continue;
		const typedKey = key as keyof GrepSkippedStats;
		merged[typedKey] = (merged[typedKey] ?? 0) + count;
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
