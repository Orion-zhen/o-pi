import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { bindOperationContext } from "../../filesystem/operation-context.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { fail, isFailed, type FailedResult, type ToolOutcome } from "../shared/result.js";
import type { RankedRegion, VerifiedCodeRegion } from "./candidates.js";
import { buildScopeInventory, type ScopeInventory } from "./inventory.js";
import { applyAstRelationFallback, buildLocalAutoResults, semanticParsePriority } from "./local.js";
import { applyGrepHints, grepHintDemand, queryGrepHints } from "./hints.js";
import { packGrepResults, renderGrepSuccess } from "./packer.js";
import { GrepParser } from "./parser-pool.js";
import { rankCodeRegions } from "./ranking.js";
import type { GrepHintSource } from "./ports.js";
import { createQueryPlan, type QueryPlan } from "./query-plan.js";
import { GrepRegionizer } from "./regionizer.js";
import { scanInventoryText } from "./text-scanner.js";
import type { GrepParams, GrepScopeError, GrepStats, GrepSuccess, TruncationReason } from "./types.js";

type GrepSkippedStats = NonNullable<GrepSuccess["stats"]["skipped_files"]>;

export interface GrepCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits,
		"grep_max_depth" | "grep_ast_max_file_bytes" | "grep_output_token_budget" | "grep_result_limit" | "grep_regional_display_limit" | "grep_relation_action_limit">;
	readonly lspHints?: GrepHintSource;
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
			return plan.match === "auto" ? await this.grepAuto(plan, context) : await this.grepStrict(plan, context);
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

	private async grepAuto(plan: QueryPlan, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (plan.match !== "auto") return fail("INVALID_OPERATION", "Auto grep requires auto mode.");
		const inventory = await this.inventory(plan, context);
		if (isFailed(inventory)) return inventory;
		const scanned = await scanInventoryText(inventory, plan, {
			filesystem: context.filesystem,
			operation: context.operation,
		});
		if (isFailed(scanned)) return scanned;
		const regionized = await this.regionizer.regionizeAuto(
			inventory,
			scanned.hits,
			semanticParsePriority(inventory, scanned, plan),
			{
				filesystem: context.filesystem,
				operation: context.operation,
				astMaxFileBytes: context.limits.grep_ast_max_file_bytes,
			},
		);
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, inventory, scanned.scopeErrors, regionized.scopeErrors);
		if (scope.failure !== undefined) return scope.failure;
		const local = buildLocalAutoResults(plan, scanned, regionized, context.limits.grep_regional_display_limit);
		const demand = grepHintDemand(plan, local);
		const hints = await queryGrepHints(
			inventory,
			plan,
			context.lspHints,
			demand,
			context.operation.signal,
			context.limits.grep_result_limit,
		);
		if (isFailed(hints)) return hints;
		const hinted = applyGrepHints(plan, local, regionized.files, hints);
		const augmented = applyAstRelationFallback(plan, hinted, regionized.files);
		return packGrepResults({
			query: plan.query,
			path: scope.paths[0] ?? ".",
			match: "auto",
			paths: scope.paths,
			...(scope.errors.length === 0 ? {} : { scopeErrors: scope.errors }),
			totalCandidates: augmented.totalCandidates,
			regions: augmented.ranked,
			stats: grepStats(inventory, scanned.stats, regionized.parsedFiles, regionized.skipped),
			truncationReasons: uniqueTruncationReasons([
				...inventory.truncationReasons,
				...scanned.truncationReasons,
				...regionized.truncationReasons,
			]),
			tokenBudget: context.limits.grep_output_token_budget,
			resultLimit: context.limits.grep_result_limit,
			regionalDisplayLimit: context.limits.grep_regional_display_limit,
			relationActionLimit: context.limits.grep_relation_action_limit,
		});
	}

	private async grepStrict(plan: QueryPlan, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (plan.match === "auto") return fail("INVALID_OPERATION", "Strict grep requires literal or regex mode.");
		const strictMatch = plan.match;
		const inventory = await this.inventory(plan, context);
		if (isFailed(inventory)) return inventory;
		const scanned = await scanInventoryText(inventory, plan, {
			filesystem: context.filesystem,
			operation: context.operation,
		});
		if (isFailed(scanned)) return scanned;
		const regionized = await this.regionizer.regionize(inventory, scanned.hits, {
			filesystem: context.filesystem,
			operation: context.operation,
			astMaxFileBytes: context.limits.grep_ast_max_file_bytes,
		});
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, inventory, scanned.scopeErrors, regionized.scopeErrors);
		if (scope.failure !== undefined) return scope.failure;
		const allRanked = rankCodeRegions(plan, regionized.regions);
		const ranked = allRanked.filter(isVerifiedRankedRegion);
		return packGrepResults({
			query: plan.query,
			path: scope.paths[0] ?? ".",
			paths: scope.paths,
			...(scope.errors.length === 0 ? {} : { scopeErrors: scope.errors }),
			match: strictMatch,
			totalCandidates: allRanked.length,
			regions: ranked,
			stats: grepStats(inventory, scanned.stats, regionized.parsedFiles, regionized.skipped),
			truncationReasons: uniqueTruncationReasons([
				...inventory.truncationReasons,
				...scanned.truncationReasons,
				...regionized.truncationReasons,
			]),
			tokenBudget: context.limits.grep_output_token_budget,
			resultLimit: context.limits.grep_result_limit,
			regionalDisplayLimit: context.limits.grep_regional_display_limit,
			relationActionLimit: context.limits.grep_relation_action_limit,
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
	scan: { readonly searchedFiles: number; readonly searchedBytes: number; readonly skipped: GrepSkippedStats },
	parsedFiles: number,
	regionSkipped: GrepSkippedStats,
): GrepStats {
	const skipped = mergeGrepSkipped([inventory.skipped, scan.skipped, regionSkipped]);
	return {
		traversed_entries: inventory.traversedEntries,
		searched_files: scan.searchedFiles,
		searched_bytes: scan.searchedBytes,
		parsed_files: parsedFiles,
		...(Object.keys(skipped).length === 0 ? {} : { skipped_files: skipped }),
	};
}

function isVerifiedRankedRegion(region: RankedRegion): region is RankedRegion & VerifiedCodeRegion {
	return region.queryMatch === "verified";
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

function uniqueTruncationReasons(values: readonly TruncationReason[]): TruncationReason[] {
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
