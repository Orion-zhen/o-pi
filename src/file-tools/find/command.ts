import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { DirectoryRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { combineOperationContext } from "../shared/operation-context.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.js";
import { createFindQueryPlan } from "./query.js";
import { createLimitedFindRanker } from "./ranker.js";
import { renderFindResults } from "./renderer.js";
import type { FindEntry, FindParams, FindScopeError, FindStats, FindSuccess } from "./types.js";

interface NormalizedFindParams {
	readonly query: string;
	readonly paths: readonly string[];
	readonly glob?: string;
}

interface NormalizedFindScope {
	readonly root: DirectoryRef;
	readonly order: number;
}

interface ScopeDiscovery {
	readonly stats: FindStats;
	readonly consumedEntries: number;
	readonly depthLimited: boolean;
	readonly entryLimited: boolean;
}

export interface FindCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits, "find_output_token_budget" | "find_result_limit" | "find_max_depth" | "find_max_entries">;
}

/** find command 持有统一取消 owner；查询与排名本身无跨 invocation 状态。 */
export class FindTool {
	private readonly owner = new AbortController();
	private disposed = false;

	async execute(params: FindParams, context: FindCommandContext): Promise<ToolOutcome<FindSuccess>> {
		if (this.disposed) return fail("OPERATION_ABORTED", "find is shut down.");
		context = { ...context, operation: combineOperationContext(context.operation, this.owner.signal) };
		const normalized = validateFindParams(params);
		if (isFailed(normalized)) return normalized;
		const plan = createFindQueryPlan(normalized.query);
		if (isFailed(plan)) return plan;
		if (isOperationAborted(context.operation)) return aborted();

		const scopeErrors: FindScopeError[] = [];
		const resolved: NormalizedFindScope[] = [];
		for (const [order, inputPath] of normalized.paths.entries()) {
			const root = await resolveSearchRoot(inputPath, context);
			if (isFailed(root)) {
				scopeErrors.push({ path: inputPath, error: root.error });
				continue;
			}
			resolved.push({ root, order });
		}

		const scopes = resolveEffectiveScopes(resolved, context.filesystem);
		const ranker = createLimitedFindRanker(plan, context.limits.find_result_limit);
		const seenPaths = new Set<string>();
		let totalCandidates = 0;
		const discoveries: Array<{ scope: NormalizedFindScope; result: ScopeDiscovery }> = [];
		let remainingEntries = context.limits.find_max_entries;
		for (const scope of scopes) {
			if (isOperationAborted(context.operation)) return aborted();
			const result = await discoverScope(scope, normalized.glob, remainingEntries, context, (entry) => {
				if (seenPaths.has(entry.path)) return;
				seenPaths.add(entry.path);
				totalCandidates += 1;
				ranker.add(entry);
			});
			if (isFailed(result)) scopeErrors.push({ path: scope.root.displayPath, error: result.error });
			else {
				discoveries.push({ scope, result });
				remainingEntries = Math.max(0, remainingEntries - result.consumedEntries);
				if (result.entryLimited) break;
			}
		}
		if (isOperationAborted(context.operation)) return aborted();
		if (discoveries.length === 0) {
			const first = scopeErrors[0];
			if (first === undefined) return fail("PATH_NOT_FOUND", "No searchable scope was provided.");
			return withScopeErrors({ status: "failed", error: first.error }, normalized.paths, scopeErrors);
		}

		if (isOperationAborted(context.operation)) return aborted();
		const ranking = ranker.result();
		const selected = ranking.ranked;
		const matches = selected.map(({ entry }) => ({ path: entry.path, kind: entry.kind }));
		const paths = discoveries.map(({ scope }) => scope.root.displayPath);
		return renderFindResults({
			query: normalized.query,
			path: paths[0] ?? ".",
			paths,
			...(normalized.glob === undefined ? {} : { glob: normalized.glob }),
			...(scopeErrors.length === 0 ? {} : { scopeErrors }),
			totalCandidates,
			totalMatches: ranking.totalMatches,
			matches,
			stats: sumStats(discoveries),
			depthLimited: discoveries.some(({ result }) => result.depthLimited),
			entryLimited: discoveries.some(({ result }) => result.entryLimited),
			resultLimited: selected.length < ranking.totalMatches,
			outputTokenBudget: context.limits.find_output_token_budget,
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.owner.abort(new Error("find is shut down."));
	}
}

function validateFindParams(params: FindParams): ToolOutcome<NormalizedFindParams> {
	const rawPaths = params.path ?? ["."];
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const searchPath of rawPaths) {
		if (searchPath.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: searchPath });
		if (!seen.has(searchPath)) {
			seen.add(searchPath);
			paths.push(searchPath);
		}
	}
	if (params.glob !== undefined && (params.glob.includes("\0") || /[\r\n]/u.test(params.glob))) {
		return fail("INVALID_PATH", "glob must be a single-line string without NUL bytes.");
	}
	return {
		query: params.query,
		paths,
		...(params.glob === undefined ? {} : { glob: params.glob }),
	};
}

async function resolveSearchRoot(input: string, context: FindCommandContext): Promise<ToolOutcome<DirectoryRef>> {
	if (input === ".") return context.filesystem.root;
	const resolved = await context.filesystem.paths.resolveExisting(
		input,
		{ expected: "directory", followFinalSymlink: true },
	);
	if (!resolved.ok) {
		const message = resolved.error.code === "not-found" ? "Directory does not exist."
			: resolved.error.code === "not-directory" ? "Path is not a directory."
				: undefined;
		return mapFsError(resolved.error, message === undefined ? {} : { message });
	}
	return resolved.value;
}

function resolveEffectiveScopes(
	scopes: readonly NormalizedFindScope[],
	filesystem: WorkspaceFileSystem,
): NormalizedFindScope[] {
	return scopes.filter((scope, index) => !scopes.some((parent, parentIndex) => {
		if (parentIndex === index || !filesystem.paths.isWithin(parent.root, scope.root)) return false;
		const sameDirectory = filesystem.paths.isWithin(scope.root, parent.root);
		return !sameDirectory || parentIndex < index;
	}));
}

async function discoverScope(
	scope: NormalizedFindScope,
	glob: string | undefined,
	maxEntries: number,
	context: FindCommandContext,
	onEntry: (entry: FindEntry) => void,
): Promise<ToolOutcome<ScopeDiscovery>> {
	const opened = await context.filesystem.discovery.discoverPaths(scope.root, {
		maxDepth: context.limits.find_max_depth,
		maxEntries,
		...(glob === undefined ? {} : { glob }),
	});
	if (!opened.ok) return mapFsError(opened.error, { message: "Directory cannot be searched." });
	let traversedEntries = 0;
	let ignoredEntries = 0;
	let skippedEntries = 0;
	let consumedEntries = 0;
	let depthLimited = false;
	let entryLimited = false;
	let processedEvents = 0;
	try {
		for await (const event of opened.value) {
			processedEvents += 1;
			if (processedEvents % 256 === 0) {
				await yieldToEventLoop();
				if (isOperationAborted(context.operation)) return aborted(scope.root.displayPath);
			}
			if (event.type === "entry") {
				consumedEntries += 1;
				if (event.ref.kind === "file" || event.ref.kind === "directory") {
					traversedEntries += 1;
					onEntry({
						path: normalizeOutputPath(event.ref.displayPath),
						searchPath: event.relativePath,
						kind: event.ref.kind,
						scopeOrder: scope.order,
					});
				}
				continue;
			}
			if (event.type === "skip") {
				if (event.reason === "depth-limit") depthLimited = true;
				else if (event.reason === "entry-limit") entryLimited = true;
				else if (event.reason === "ignored") {
					consumedEntries += 1;
					ignoredEntries += 1;
				} else if (event.reason === "symlink") consumedEntries += 1;
				continue;
			}
			if (event.error.code === "aborted") return aborted(scope.root.displayPath);
			if (event.kind !== undefined) consumedEntries += 1;
			skippedEntries += 1;
		}
	} finally {
		await opened.value.close();
	}
	return {
		stats: {
			traversed_entries: traversedEntries,
			ignored_entries: ignoredEntries,
			skipped_entries: skippedEntries,
		},
		consumedEntries,
		depthLimited,
		entryLimited,
	};
}

function normalizeOutputPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function sumStats(discoveries: readonly { result: ScopeDiscovery }[]): FindStats {
	return discoveries.reduce<FindStats>((stats, { result }) => ({
		traversed_entries: stats.traversed_entries + result.stats.traversed_entries,
		ignored_entries: stats.ignored_entries + result.stats.ignored_entries,
		skipped_entries: stats.skipped_entries + result.stats.skipped_entries,
	}), { traversed_entries: 0, ignored_entries: 0, skipped_entries: 0 });
}

function withScopeErrors(
	result: FailedResult,
	paths: readonly string[],
	scopeErrors: FindScopeError[],
): FailedResult {
	return {
		...result,
		error: {
			...result.error,
			details: { ...(result.error.details ?? {}), paths: [...paths], scope_errors: scopeErrors },
		},
	};
}

function isOperationAborted(operation: FsOperationContext): boolean {
	return operation.signal?.aborted === true;
}

function aborted(path?: string): FailedResult {
	return fail("OPERATION_ABORTED", "find was aborted.", path === undefined ? {} : { path });
}
