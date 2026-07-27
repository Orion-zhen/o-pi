import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { bindOperationContext } from "../../filesystem/operation-context.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { fail, isFailed, type FailedResult, type ToolOutcome } from "../shared/result.js";
import type { VerifiedCodeRegion } from "./candidates.js";
import { buildScopeInventory, type ScopeInventory } from "./inventory.js";
import { augmentLocalAutoResults, buildLocalAutoResults, semanticParsePriority, type ExternalAutoCandidates } from "./local.js";
import { packAutoResults, packVerifiedTextResults, renderGrepSuccess } from "./packer.js";
import { GrepParser } from "./parser-pool.js";
import type { GrepGraphSource, GrepSymbolSource } from "./ports.js";
import { createQueryPlan, type QueryPlan } from "./query-plan.js";
import { GrepRegionizer, strictRegionContent } from "./regionizer.js";
import { scanInventoryText } from "./text-scanner.js";
import type { GrepParams, GrepRegion, GrepScopeError, GrepStats, GrepSuccess, TruncationReason } from "./types.js";

type GrepSkippedStats = NonNullable<GrepSuccess["stats"]["skipped_files"]>;

export interface GrepCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits,
		"grep_max_entries_traversed" | "grep_max_text_bytes_scanned" | "grep_max_text_file_bytes"
		| "grep_max_files_parsed" | "grep_max_parse_file_bytes" | "grep_output_token_budget" | "grep_result_limit">;
	readonly symbols?: GrepSymbolSource;
	readonly graph?: GrepGraphSource;
}

/** Stateful grep command; parser、派生 AST cache 与 active invocation 共享 owner。 */
export class GrepTool {
	private readonly parser = new GrepParser();
	private readonly regionizer = new GrepRegionizer(this.parser);
	private readonly owner = new AbortController();
	private disposed = false;

	async execute(params: GrepParams, context: GrepCommandContext): Promise<ToolOutcome<GrepSuccess>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		context = { ...context, operation: bindOperationContext(this.owner.signal, context.operation) };
		const plan = createQueryPlan(params);
		if (isFailed(plan)) return plan;
		return plan.match === "auto" ? await this.grepAuto(plan, context) : await this.grepStrict(plan, context);
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
			maxTextBytesScanned: context.limits.grep_max_text_bytes_scanned,
			maxTextFileBytes: context.limits.grep_max_text_file_bytes,
		});
		if (isFailed(scanned)) return scanned;
		const regionized = await this.regionizer.regionizeAuto(
			inventory,
			scanned.hits,
			semanticParsePriority(inventory, scanned, plan),
			{
				filesystem: context.filesystem,
				operation: context.operation,
				maxFilesParsed: context.limits.grep_max_files_parsed,
				maxParseFileBytes: context.limits.grep_max_parse_file_bytes,
			},
		);
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, inventory, scanned.scopeErrors, regionized.scopeErrors);
		if (scope.failure !== undefined) return scope.failure;
		const local = buildLocalAutoResults(plan, scanned, regionized, context.limits.grep_result_limit);
		const external = await queryExternalCandidates(inventory, plan, context);
		if (isAborted(context.operation.signal)) return aborted(scope.paths[0]);
		const augmented = augmentLocalAutoResults(plan, local, regionized, external, context.limits.grep_result_limit);
		return packAutoResults({
			query: plan.query,
			path: scope.paths[0] ?? ".",
			paths: scope.paths,
			...(scope.errors.length === 0 ? {} : { scopeErrors: scope.errors }),
			totalCandidates: augmented.ranked.length,
			regions: augmented.ranked,
			sourceText: augmented.sourceText,
			snippets: augmented.snippets,
			stats: grepStats(inventory, scanned.stats, regionized.parsedFiles, regionized.skipped),
			truncationReasons: uniqueTruncationReasons([
				...inventory.truncationReasons,
				...scanned.truncationReasons,
				...regionized.truncationReasons,
			]),
			tokenBudget: context.limits.grep_output_token_budget,
			resultLimit: context.limits.grep_result_limit,
			nearby: augmented.nearby,
			related: augmented.related,
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
			maxTextBytesScanned: context.limits.grep_max_text_bytes_scanned,
			maxTextFileBytes: context.limits.grep_max_text_file_bytes,
		});
		if (isFailed(scanned)) return scanned;
		const regionized = await this.regionizer.regionize(inventory, scanned.hits, {
			filesystem: context.filesystem,
			operation: context.operation,
			maxFilesParsed: context.limits.grep_max_files_parsed,
			maxParseFileBytes: context.limits.grep_max_parse_file_bytes,
		});
		if (isFailed(regionized)) return regionized;
		const scope = successfulScopeState(plan, inventory, scanned.scopeErrors, regionized.scopeErrors);
		if (scope.failure !== undefined) return scope.failure;
		return packVerifiedTextResults({
			query: plan.query,
			path: scope.paths[0] ?? ".",
			paths: scope.paths,
			...(scope.errors.length === 0 ? {} : { scopeErrors: scope.errors }),
			match: strictMatch,
			totalCandidates: regionized.regions.length,
			regions: regionized.regions.map(strictPublicRegion),
			stats: grepStats(inventory, scanned.stats, regionized.parsedFiles, regionized.skipped),
			truncationReasons: uniqueTruncationReasons([
				...inventory.truncationReasons,
				...scanned.truncationReasons,
				...regionized.truncationReasons,
			]),
			tokenBudget: context.limits.grep_output_token_budget,
			resultLimit: context.limits.grep_result_limit,
		});
	}

	private async inventory(plan: QueryPlan, context: GrepCommandContext): Promise<ToolOutcome<ScopeInventory>> {
		return await buildScopeInventory({
			paths: plan.paths,
			...(plan.glob === undefined ? {} : { glob: plan.glob }),
		}, {
			filesystem: context.filesystem,
			operation: context.operation,
			maxEntriesTraversed: context.limits.grep_max_entries_traversed,
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

function strictPublicRegion(region: VerifiedCodeRegion): GrepRegion {
	const content = strictRegionContent(region);
	return {
		path: region.path,
		start_line: region.startLine,
		end_line: region.endLine,
		kind: region.kind,
		...(region.symbol === undefined ? {} : { symbol: region.symbol }),
		...(region.signature === undefined ? {} : { signature: region.signature }),
		detail: "snippet",
		query_match: "verified",
		reasons: uniqueStrings(region.evidence.map((item) => item.reason)),
		sources: uniqueStrings(region.evidence.map((item) => item.source)),
		match_lines: [...region.matchLines],
		...(content.length === 0 ? {} : { content }),
	};
}

async function queryExternalCandidates(
	inventory: ScopeInventory,
	plan: QueryPlan,
	context: GrepCommandContext,
): Promise<ExternalAutoCandidates> {
	const allowed = new Set(inventory.files.map((file) => file.path));
	const requests = inventory.scopes.flatMap((scope) => {
		const allowedPaths = inventory.files.filter((file) => file.scopeOrder === scope.order).map((file) => file.path);
		const symbols = context.symbols === undefined
			? Promise.resolve([])
			: context.symbols.query({
				root: scope.root,
				query: plan.targetQuery.length === 0 ? plan.query : plan.targetQuery,
				allowedPaths,
				...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
			}).catch(() => []);
		const graph = context.graph === undefined
			? Promise.resolve(undefined)
			: context.graph.query({
				root: scope.root,
				query: plan.targetQuery.length === 0 ? plan.query : plan.targetQuery,
				limit: Math.max(24, context.limits.grep_result_limit * 6),
				...(context.operation.signal === undefined ? {} : { signal: context.operation.signal }),
			}).catch(() => undefined);
		return [{ symbols, graph }];
	});
	const results = await Promise.all(requests.map(async (request) => {
		const [symbols, graph] = await Promise.all([request.symbols, request.graph]);
		return { symbols, graph };
	}));
	return {
		symbols: results.flatMap((result) => result.symbols).filter((candidate) => allowed.has(candidate.path)),
		graph: results.flatMap((result) => result.graph?.candidates ?? []).filter((candidate) => allowed.has(candidate.path)),
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
