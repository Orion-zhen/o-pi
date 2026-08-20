import type { DiscoveryEvent } from "../../filesystem/contracts/discovery.js";
import type { FileSnapshot } from "../../filesystem/contracts/metadata.js";
import type { DirectoryRef, FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.js";
import { compactGrepSkippedFiles, createGrepSkippedFiles, type MutableGrepSkippedFiles } from "./skipped.js";
import type { GrepScopeError, GrepSkippedFiles, TruncationReason } from "./types.js";

export interface InventoryScope {
	readonly input: string;
	readonly order: number;
	readonly root: FileRef | DirectoryRef;
	readonly visibilityBypass: boolean;
}

export interface ScopedFileMembership {
	readonly scopeInput: string;
	readonly scopeOrder: number;
	readonly scopeRelativePath: string;
	readonly explicitFile: boolean;
	readonly visibilityBypass: boolean;
}

export interface ScopedFile {
	readonly ref: FileRef;
	readonly path: string;
	readonly snapshot: FileSnapshot;
	readonly scopeInput: string;
	readonly scopeOrder: number;
	readonly scopeRelativePath: string;
	readonly explicitFile: boolean;
	readonly visibilityBypass: boolean;
	/** 同一文件可由多个显式 scope 发现；外部通道按此集合获得完整准入范围。 */
	readonly memberships: readonly ScopedFileMembership[];
}

export interface ScopeInventory {
	readonly scopes: readonly InventoryScope[];
	readonly files: readonly ScopedFile[];
	readonly scopeErrors: readonly GrepScopeError[];
	readonly skipped: GrepSkippedFiles;
	readonly traversedEntries: number;
	readonly truncationReasons: readonly TruncationReason[];
}

export interface ScopeInventoryContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxDepth: number;
	readonly maxEntries: number;
}

interface MutableInventoryState {
	readonly context: ScopeInventoryContext;
	readonly glob?: string;
	readonly scopes: InventoryScope[];
	readonly files: ScopedFile[];
	readonly scopeErrors: GrepScopeError[];
	readonly seenFiles: Map<string, number>;
	readonly skipped: MutableGrepSkippedFiles;
	readonly truncationReasons: Set<TruncationReason>;
	traversedEntries: number;
}

/** 只聚合每个 scope 的 discovery 事实，不读取正文或实现文件发现策略。 */
export async function buildScopeInventory(
	input: { readonly paths: readonly string[]; readonly glob?: string },
	context: ScopeInventoryContext,
): Promise<ToolOutcome<ScopeInventory>> {
	if (!Number.isSafeInteger(context.maxDepth) || context.maxDepth < 0) {
		return fail("INVALID_OPERATION", "Traversal depth limit must be a non-negative integer.");
	}
	if (!Number.isSafeInteger(context.maxEntries) || context.maxEntries < 0) {
		return fail("INVALID_OPERATION", "Traversal entry limit must be a non-negative integer.");
	}
	if (input.paths.length === 0) return fail("INVALID_PATH", "path must contain at least one scope.");
	const state: MutableInventoryState = {
		context,
		...(input.glob === undefined ? {} : { glob: input.glob }),
		scopes: [],
		files: [],
		scopeErrors: [],
		seenFiles: new Map(),
		skipped: createGrepSkippedFiles(),
		truncationReasons: new Set(),
		traversedEntries: 0,
	};

	for (const [order, scopeInput] of input.paths.entries()) {
		if (isAborted(context.operation.signal)) return aborted(scopeInput);
		if (typeof scopeInput !== "string" || scopeInput.length === 0 || scopeInput.includes("\0")) {
			state.scopeErrors.push({ path: scopeInput, error: fail("INVALID_PATH", "path entries must be non-empty strings without NUL bytes.").error });
			continue;
		}
		const resolved = await resolveScope(scopeInput, context);
		if (isFailed(resolved)) {
			if (resolved.error.code === "OPERATION_ABORTED") return resolved;
			state.scopeErrors.push({ path: scopeInput, error: resolved.error });
			continue;
		}
		const visibility = await context.filesystem.visibility.evaluate(resolved, "search", context.operation);
		if (!visibility.ok) {
			const failure = mapFsError(visibility.error, { path: resolved.displayPath });
			if (failure.error.code === "OPERATION_ABORTED") return failure;
			state.scopeErrors.push({ path: scopeInput, error: failure.error });
			continue;
		}
		const scope: InventoryScope = {
			input: scopeInput,
			order,
			root: resolved,
			visibilityBypass: visibility.value.ignored,
		};
		const discovered = await discoverScope(scope, state);
		if (isFailed(discovered)) {
			if (discovered.error.code === "OPERATION_ABORTED") return discovered;
			state.scopeErrors.push({ path: scopeInput, error: discovered.error });
		} else {
			state.scopes.push(scope);
			if (state.truncationReasons.has("entry_limit")) break;
		}
	}

	if (state.scopes.length === 0) {
		const first = state.scopeErrors[0];
		if (first === undefined) return fail("PATH_NOT_FOUND", "No searchable scope was provided.");
		return withScopeErrors({ status: "failed", error: first.error }, input.paths, state.scopeErrors);
	}
	return {
		scopes: state.scopes,
		files: state.files,
		scopeErrors: state.scopeErrors,
		skipped: compactGrepSkippedFiles(state.skipped),
		traversedEntries: state.traversedEntries,
		truncationReasons: (["depth_limit", "entry_limit"] as const)
			.filter((reason) => state.truncationReasons.has(reason)),
	};
}

async function resolveScope(input: string, context: ScopeInventoryContext): Promise<ToolOutcome<FileRef | DirectoryRef>> {
	const resolved = await context.filesystem.paths.resolveExisting(
		input,
		{ expected: "any", followFinalSymlink: true },
		context.operation,
	);
	if (!resolved.ok) return mapFsError(resolved.error, resolved.error.code === "not-found" ? { message: "Path does not exist." } : {});
	if (resolved.value.kind !== "file" && resolved.value.kind !== "directory") {
		return fail("INVALID_PATH", "Path must be a regular file or directory.", { path: resolved.value.displayPath });
	}
	return resolved.value;
}

async function discoverScope(scope: InventoryScope, state: MutableInventoryState): Promise<ToolOutcome<void>> {
	const opened = await state.context.filesystem.discovery.discover(scope.root, {
		intent: "search",
		explicitRoot: true,
		maxDepth: state.context.maxDepth,
		maxEntries: Math.max(0, state.context.maxEntries - state.traversedEntries),
		...(state.glob === undefined ? {} : { glob: state.glob }),
	}, state.context.operation);
	if (!opened.ok) {
		return mapFsError(opened.error, {
			...(scope.root.kind === "file" ? { notFound: "file" as const } : { message: "Path cannot be searched." }),
			path: scope.root.displayPath,
		});
	}
	try {
		for await (const event of opened.value) {
			if (isAborted(state.context.operation.signal)) return aborted(scope.root.displayPath);
			const failure = consumeDiscoveryEvent(event, scope, state);
			if (failure !== undefined) return failure;
		}
	} finally {
		await opened.value.close();
	}
}

function consumeDiscoveryEvent(event: DiscoveryEvent, scope: InventoryScope, state: MutableInventoryState): FailedResult | undefined {
	if (event.type === "skip") {
		if (event.reason === "depth-limit") state.truncationReasons.add("depth_limit");
		else if (event.reason === "entry-limit") state.truncationReasons.add("entry_limit");
		else if (scope.root.kind === "directory" && event.reason !== "blocked") state.traversedEntries += 1;
		return;
	}
	if (event.type === "error") {
		if (event.error.code === "aborted") return aborted(scope.root.displayPath);
		if (event.error.code === "access-denied") state.skipped.access_denied += 1;
		else if (event.error.code === "not-found" || event.error.code === "not-file") state.skipped.changed += 1;
		// 子项解析错误消耗一个 traversal entry；目录读取错误对应已统计的目录 entry。
		if (scope.root.kind === "directory" && event.kind !== undefined) state.traversedEntries += 1;
		return;
	}
	if (scope.root.kind === "directory") state.traversedEntries += 1;
	if (event.ref.kind !== "file") return;
	addFile(event.ref, event.snapshot, scope, event.relativePath, scope.root.kind === "file", state);
}

function addFile(
	ref: FileRef,
	snapshot: FileSnapshot,
	scope: InventoryScope,
	relativePath: string,
	explicitFile: boolean,
	state: MutableInventoryState,
): void {
	const existingIndex = state.seenFiles.get(snapshot.identity);
	const membership: ScopedFileMembership = {
		scopeInput: scope.input,
		scopeOrder: scope.order,
		scopeRelativePath: relativePath,
		explicitFile,
		visibilityBypass: scope.visibilityBypass,
	};
	if (existingIndex !== undefined) {
		const existing = state.files[existingIndex];
		if (existing !== undefined && !existing.memberships.some((item) => item.scopeOrder === scope.order)) {
			state.files[existingIndex] = {
				...existing,
				...(explicitFile && !existing.explicitFile ? {
					scopeInput: scope.input,
					scopeOrder: scope.order,
					scopeRelativePath: membership.scopeRelativePath,
				} : {}),
				explicitFile: existing.explicitFile || explicitFile,
				visibilityBypass: existing.visibilityBypass || scope.visibilityBypass,
				memberships: [...existing.memberships, membership],
			};
		}
		return;
	}
	state.seenFiles.set(snapshot.identity, state.files.length);
	state.files.push({
		ref,
		path: ref.displayPath,
		snapshot,
		scopeInput: scope.input,
		scopeOrder: scope.order,
		scopeRelativePath: relativePath,
		explicitFile,
		visibilityBypass: scope.visibilityBypass,
		memberships: [membership],
	});
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function aborted(path?: string): FailedResult {
	return fail("OPERATION_ABORTED", "Operation aborted.", path === undefined ? {} : { path });
}

function withScopeErrors(result: FailedResult, paths: readonly string[], scopeErrors: readonly GrepScopeError[]): FailedResult {
	return {
		...result,
		error: {
			...result.error,
			details: { ...(result.error.details ?? {}), paths: [...paths], scope_errors: [...scopeErrors] },
		},
	};
}
