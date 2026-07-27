import picomatch from "picomatch";

import type { FileMetadata } from "../../filesystem/contracts/metadata.js";
import type { DirectoryRef, FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, isFailed, mapFsError, type FailedResult, type ToolOutcome } from "../shared/result.js";
import type { GrepScopeError, GrepSkippedFiles, TruncationReason } from "./types.js";

export interface GlobPlan {
	readonly pattern: string;
	readonly matchBasename: boolean;
	readonly staticDirectoryPrefix?: string;
	matches(scopeRelativePath: string): boolean;
}

export interface InventoryScope {
	readonly input: string;
	readonly order: number;
	readonly root: FileRef | DirectoryRef;
	readonly visibilityBypass: boolean;
}

export interface ScopedFile {
	readonly ref: FileRef;
	readonly path: string;
	readonly canonicalIdentity: string;
	readonly scopeInput: string;
	readonly scopeOrder: number;
	readonly scopeRelativePath: string;
	readonly explicitFile: boolean;
	readonly visibilityBypass: boolean;
	readonly size: number;
	readonly metadataVersion: string;
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
	readonly maxEntriesTraversed: number;
}

interface MutableInventoryState {
	readonly context: ScopeInventoryContext;
	readonly glob?: GlobPlan;
	readonly scopes: InventoryScope[];
	readonly files: ScopedFile[];
	readonly scopeErrors: GrepScopeError[];
	readonly seenFiles: Map<string, number>;
	readonly skipped: Required<GrepSkippedFiles>;
	traversedEntries: number;
	traversalLimited: boolean;
}

/** 只建立当前 visibility snapshot 下的文件事实清单，不读取正文或调用增强来源。 */
export async function buildScopeInventory(
	input: { readonly paths: readonly string[]; readonly glob?: string },
	context: ScopeInventoryContext,
): Promise<ToolOutcome<ScopeInventory>> {
	if (!Number.isSafeInteger(context.maxEntriesTraversed) || context.maxEntriesTraversed < 0) {
		return fail("INVALID_OPERATION", "Traversal entry limit must be a non-negative integer.");
	}
	if (input.paths.length === 0) return fail("INVALID_PATH", "path must contain at least one scope.");
	const glob = input.glob === undefined ? undefined : createGlobPlan(input.glob);
	if (isFailed(glob)) return glob;
	const state: MutableInventoryState = {
		context,
		...(glob === undefined ? {} : { glob }),
		scopes: [],
		files: [],
		scopeErrors: [],
		seenFiles: new Map(),
		skipped: { binary: 0, invalid_utf8: 0, access_denied: 0, too_large: 0, changed: 0 },
		traversedEntries: 0,
		traversalLimited: false,
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
		const discovered = resolved.kind === "file"
			? await discoverFile(scope, state)
			: await discoverDirectory(scope, state);
		if (isFailed(discovered)) {
			if (discovered.error.code === "OPERATION_ABORTED") return discovered;
			state.scopeErrors.push({ path: scopeInput, error: discovered.error });
		} else state.scopes.push(scope);
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
		skipped: compactSkipped(state.skipped),
		traversedEntries: state.traversedEntries,
		truncationReasons: state.traversalLimited ? ["traversal_limit"] : [],
	};
}

/** 规范化并编译相对每个 scope 的 glob。 */
export function createGlobPlan(input: string): ToolOutcome<GlobPlan> {
	if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
		return fail("INVALID_PATH", "glob must be a non-empty string without NUL bytes.");
	}
	const slashed = input.replaceAll("\\", "/");
	if (isAbsolutePath(slashed)) return fail("INVALID_PATH", "glob must be relative to each scope.");
	let pattern = slashed.replace(/\/{2,}/gu, "/");
	while (pattern.startsWith("./")) pattern = pattern.slice(2);
	if (pattern.length === 0 || pattern.split("/").some((part) => part === "..")) {
		return fail("INVALID_PATH", "glob must not escape its scope.");
	}
	let matcher: (candidate: string) => boolean;
	try { matcher = picomatch(pattern, { dot: true, nonegate: true }); }
	catch (error) {
		return fail("INVALID_PATH", error instanceof Error ? error.message : "Invalid glob.");
	}
	const matchBasename = !pattern.includes("/");
	const staticDirectoryPrefix = matchBasename ? undefined : extractStaticDirectoryPrefix(pattern);
	return {
		pattern,
		matchBasename,
		...(staticDirectoryPrefix === undefined ? {} : { staticDirectoryPrefix }),
		matches(scopeRelativePath) {
			const candidate = normalizeRelativePath(scopeRelativePath);
			return matcher(matchBasename ? basename(candidate) : candidate);
		},
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

async function discoverFile(scope: InventoryScope, state: MutableInventoryState): Promise<ToolOutcome<void>> {
	if (scope.root.kind !== "file") return fail("INVALID_PATH", "Path must be a regular file.", { path: scope.root.displayPath });
	const relativePath = basename(scope.root.displayPath);
	if (state.glob !== undefined && !state.glob.matches(relativePath)) return;
	const metadata = await state.context.filesystem.metadata.stat(scope.root, state.context.operation);
	if (!metadata.ok) return mapFsError(metadata.error, { notFound: "file", path: scope.root.displayPath });
	addFile(scope.root, metadata.value, scope, relativePath, true, state);
}

async function discoverDirectory(scope: InventoryScope, state: MutableInventoryState): Promise<ToolOutcome<void>> {
	if (scope.root.kind !== "directory") return fail("INVALID_PATH", "Path must be a directory.", { path: scope.root.displayPath });
	const start = await resolveTraversalStart(scope, state);
	if (isFailed(start)) return start;
	if (start === undefined) return;
	const remaining = Math.max(0, state.context.maxEntriesTraversed - state.traversedEntries);
	const opened = await state.context.filesystem.traversal.walk(start, {
		intent: "search",
		explicitRoot: start.id === scope.root.id || scope.visibilityBypass,
		maxEntries: remaining,
	}, state.context.operation);
	if (!opened.ok) return mapFsError(opened.error, { message: "Path cannot be searched.", path: scope.root.displayPath });
	try {
		for await (const event of opened.value) {
			if (isAborted(state.context.operation.signal)) return aborted(scope.root.displayPath);
			if (event.type === "skip") {
				if (event.reason === "entry-limit") state.traversalLimited = true;
				else if (event.reason !== "blocked") state.traversedEntries += 1;
				continue;
			}
			if (event.type === "error") {
				if (event.error.code === "aborted") return aborted(scope.root.displayPath);
				if (event.error.code === "access-denied") state.skipped.access_denied += 1;
				else if (event.error.code === "not-found" || event.error.code === "not-file") state.skipped.changed += 1;
				// 子项解析错误消耗一个 traversal entry；目录读取错误对应已统计的目录 entry。
				if (event.kind !== undefined) state.traversedEntries += 1;
				continue;
			}
			state.traversedEntries += 1;
			if (event.ref.kind !== "file") continue;
			const relativePath = relativeDisplayPath(scope.root.displayPath, event.ref.displayPath);
			if (relativePath === undefined || (state.glob !== undefined && !state.glob.matches(relativePath))) continue;
			addFile(event.ref, event.metadata, scope, relativePath, false, state);
		}
	} finally {
		await opened.value.close();
	}
}

async function resolveTraversalStart(
	scope: InventoryScope,
	state: MutableInventoryState,
): Promise<ToolOutcome<DirectoryRef | undefined>> {
	const prefix = state.glob?.staticDirectoryPrefix;
	if (prefix === undefined) return scope.root.kind === "directory" ? scope.root : undefined;
	const resolved = await state.context.filesystem.paths.resolveExisting(
		joinDisplayPath(scope.root.displayPath, prefix),
		{ expected: "any", followFinalSymlink: false },
		state.context.operation,
	);
	if (!resolved.ok) {
		if (resolved.error.code === "not-found" || resolved.error.code === "not-directory") return undefined;
		return mapFsError(resolved.error, { path: scope.root.displayPath });
	}
	if (resolved.value.kind !== "directory" || scope.root.kind !== "directory" || !state.context.filesystem.paths.isWithin(scope.root, resolved.value)) return undefined;
	return resolved.value;
}

function addFile(
	ref: FileRef,
	metadata: FileMetadata,
	scope: InventoryScope,
	relativePath: string,
	explicitFile: boolean,
	state: MutableInventoryState,
): void {
	const canonicalIdentity = `${state.context.filesystem.identity}\0${metadata.identity ?? normalizeDisplayPath(ref.displayPath)}`;
	const existingIndex = state.seenFiles.get(canonicalIdentity);
	if (existingIndex !== undefined) {
		const existing = state.files[existingIndex];
		if (existing !== undefined && ((explicitFile && !existing.explicitFile) || (scope.visibilityBypass && !existing.visibilityBypass))) {
			state.files[existingIndex] = {
				...existing,
				...(explicitFile && !existing.explicitFile ? { scopeInput: scope.input, scopeOrder: scope.order } : {}),
				explicitFile: existing.explicitFile || explicitFile,
				visibilityBypass: existing.visibilityBypass || scope.visibilityBypass,
			};
		}
		return;
	}
	state.seenFiles.set(canonicalIdentity, state.files.length);
	state.files.push({
		ref,
		path: ref.displayPath,
		canonicalIdentity,
		scopeInput: scope.input,
		scopeOrder: scope.order,
		scopeRelativePath: normalizeRelativePath(relativePath),
		explicitFile,
		visibilityBypass: scope.visibilityBypass,
		size: metadata.sizeBytes,
		metadataVersion: metadata.version ?? `${metadata.sizeBytes}:${metadata.modifiedAtMs}`,
	});
}

function extractStaticDirectoryPrefix(pattern: string): string | undefined {
	const scanned = picomatch.scan(pattern);
	const base = normalizeRelativePath(scanned.base);
	if (base.length === 0) return undefined;
	if (scanned.isGlob) return base;
	const separator = base.lastIndexOf("/");
	return separator <= 0 ? undefined : base.slice(0, separator);
}

function relativeDisplayPath(rootPath: string, childPath: string): string | undefined {
	const root = normalizeDisplayPath(rootPath);
	const child = normalizeDisplayPath(childPath);
	if (root === ".") return isAbsolutePath(child) ? undefined : normalizeRelativePath(child);
	if (child === root) return "";
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return child.startsWith(prefix) ? normalizeRelativePath(child.slice(prefix.length)) : undefined;
}

function joinDisplayPath(root: string, relative: string): string {
	if (root === ".") return relative;
	if (root === "/") return `/${relative}`;
	return `${root.replace(/\/+$/u, "")}/${relative}`;
}

function normalizeDisplayPath(value: string): string {
	const normalized = value.replaceAll("\\", "/");
	return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

function normalizeRelativePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
}

function basename(value: string): string {
	const normalized = normalizeDisplayPath(value);
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:\//u.test(value);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function aborted(path?: string): FailedResult {
	return fail("OPERATION_ABORTED", "Operation aborted.", path === undefined ? {} : { path });
}

function compactSkipped(skipped: Required<GrepSkippedFiles>): GrepSkippedFiles {
	const result: GrepSkippedFiles = {};
	if (skipped.binary > 0) result.binary = skipped.binary;
	if (skipped.invalid_utf8 > 0) result.invalid_utf8 = skipped.invalid_utf8;
	if (skipped.access_denied > 0) result.access_denied = skipped.access_denied;
	if (skipped.too_large > 0) result.too_large = skipped.too_large;
	if (skipped.changed > 0) result.changed = skipped.changed;
	return result;
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
