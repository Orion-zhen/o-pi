import type { DirectoryRef, ExistingRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import type {
	PathTraversal,
	PathTraversalEntryEvent,
	Traversal,
	TraversalEntryEvent,
	TraversalErrorEvent,
	TraversalOperations,
	TraversalOptions,
	TraversalSkipEvent,
} from "../contracts/traversal.js";
import type { VisibilityAnnotation, VisibilityOperations } from "../contracts/visibility.js";
import { mapNativeError } from "../kernel/native-error.js";
import type { ResolvedExistingPath, WorkspaceNamespaceBridge } from "../kernel/namespace.js";
import { bindOperationContext } from "../operation-context.js";
import type {
	NativeDirectoryEntry,
	NativeFileSystem,
	NativeMetadata,
} from "../platform/node/native-filesystem.js";
import { DIRECTORY_ENTRY_CONCURRENCY } from "./concurrency.js";
import { compareLogicalPath } from "./path-order.js";
import { nativeIdentity } from "./ref.js";

const VISIBLE: VisibilityAnnotation = { ignored: false, prune: false };

interface PreparedTraversalRoot {
	readonly context: FsOperationContext;
	readonly entries: readonly NativeDirectoryEntry[];
	readonly rootVisibility: VisibilityAnnotation;
	readonly rootMetadata?: NativeMetadata;
	readonly bypassVisibility: boolean;
	readonly rootSkipped: boolean;
}

interface PathTraversalChild {
	readonly ref: ExistingRef;
}

interface TraversalEntryBase {
	readonly type: "entry";
	readonly ref: ExistingRef;
	readonly depth: number;
	readonly visibility: VisibilityAnnotation;
}

type TraversalStreamEvent<TEntry extends TraversalEntryBase> =
	| TEntry
	| TraversalSkipEvent
	| TraversalErrorEvent;

type ResolveTraversalChild<TChild extends PathTraversalChild> = (
	directory: DirectoryRef,
	entry: NativeDirectoryEntry,
	context: FsOperationContext,
) => Promise<FsResult<TChild>>;

type CreateTraversalEntry<TChild extends PathTraversalChild, TEntry extends TraversalEntryBase> = (
	child: TChild,
	depth: number,
	visibility: VisibilityAnnotation,
	relativePath: string,
) => TEntry;

/** Deterministic, cancellable depth-first traversal with mandatory access and visibility gates. */
export class WorkspaceTraversalService implements TraversalOperations {
	constructor(
		private readonly native: NativeFileSystem,
		private readonly bridge: WorkspaceNamespaceBridge,
		private readonly visibility: VisibilityOperations,
		private readonly ownerSignal?: AbortSignal,
	) {}

	async walk(root: DirectoryRef, options: TraversalOptions, context: FsOperationContext): Promise<FsResult<Traversal>> {
		const prepared = await this.prepareRoot(root, options, context, options.includeRoot === true);
		if (!prepared.ok) return prepared;
		const rootEntry = options.includeRoot === true && prepared.value.rootMetadata !== undefined
			? entryEvent({ ref: root, metadata: prepared.value.rootMetadata }, 0, prepared.value.rootVisibility)
			: undefined;
		return fsSuccess(new NativeTraversal<ResolvedExistingPath, TraversalEntryEvent>(
			this.native,
			this.bridge,
			this.visibility,
			root,
			prepared.value.entries,
			prepared.value.bypassVisibility,
			prepared.value.rootSkipped,
			options,
			prepared.value.context,
			async (directory, entry, operation) => await this.bridge.resolveChild(directory, entry.name, operation),
			entryEvent,
			rootEntry,
			false,
		));
	}

	async walkPaths(
		root: DirectoryRef,
		options: Omit<TraversalOptions, "includeRoot">,
		context: FsOperationContext,
	): Promise<FsResult<PathTraversal>> {
		const prepared = await this.prepareRoot(root, options, context, false);
		if (!prepared.ok) return prepared;
		return fsSuccess(new NativeTraversal<PathTraversalChild, PathTraversalEntryEvent>(
			this.native,
			this.bridge,
			this.visibility,
			root,
			prepared.value.entries,
			prepared.value.bypassVisibility,
			prepared.value.rootSkipped,
			options,
			prepared.value.context,
			async (directory, entry, operation) => await this.resolvePathChild(directory, entry, operation),
			pathEntryEvent,
			undefined,
			true,
		));
	}

	private async prepareRoot(
		root: DirectoryRef,
		options: TraversalOptions,
		context: FsOperationContext,
		includeRootMetadata: boolean,
	): Promise<FsResult<PreparedTraversalRoot>> {
		context = bindOperationContext(this.ownerSignal, context);
		const invalid = validateOptions(root, options);
		if (invalid !== undefined) return invalid;
		const rootIdentity = nativeIdentity(this.bridge, root);
		if (!rootIdentity.ok) return rootIdentity;
		const rootVisibility = await this.visibility.evaluate(root, options.intent, context);
		if (!rootVisibility.ok) return rootVisibility;
		const bypassVisibility = options.explicitRoot === true && rootVisibility.value.ignored;
		if (rootVisibility.value.ignored && !bypassVisibility) {
			return fsSuccess({
				context,
				entries: [],
				rootVisibility: rootVisibility.value,
				bypassVisibility: false,
				rootSkipped: true,
			});
		}

		let entries: readonly NativeDirectoryEntry[];
		let rootMetadata: NativeMetadata | undefined;
		try {
			[entries, rootMetadata] = await Promise.all([
				this.native.readdir(rootIdentity.value.nativePath, context),
				includeRootMetadata
					? this.native.stat(rootIdentity.value.nativePath, context)
					: Promise.resolve(undefined),
			]);
		} catch (error) {
			return fsFailure(mapNativeError(error, root.displayPath));
		}
		if (!bypassVisibility) {
			const preparedVisibility = await this.visibility.prepareDirectory(root, entries, context);
			if (!preparedVisibility.ok) return preparedVisibility;
		}
		return fsSuccess({
			context,
			entries,
			rootVisibility: rootVisibility.value,
			...(rootMetadata === undefined ? {} : { rootMetadata }),
			bypassVisibility,
			rootSkipped: false,
		});
	}

	private async resolvePathChild(
		directory: DirectoryRef,
		entry: NativeDirectoryEntry,
		context: FsOperationContext,
	): Promise<FsResult<PathTraversalChild>> {
		if (entry.kind === "file") {
			const projected = this.bridge.projectListedChild(directory, entry.name, "file", context);
			return projected.ok ? fsSuccess({ ref: projected.value }) : projected;
		}
		if (entry.kind === "directory") {
			const projected = this.bridge.projectListedChild(directory, entry.name, "directory", context);
			return projected.ok ? fsSuccess({ ref: projected.value }) : projected;
		}
		const resolved = await this.bridge.resolveChild(directory, entry.name, context);
		return resolved.ok ? fsSuccess({ ref: resolved.value.ref }) : resolved;
	}
}

class NativeTraversal<TChild extends PathTraversalChild, TEntry extends TraversalEntryBase>
implements AsyncIterable<TraversalStreamEvent<TEntry>> {
	private stopped = false;
	private consumed = false;
	private scannedEntries = 0;

	constructor(
		private readonly native: NativeFileSystem,
		private readonly bridge: WorkspaceNamespaceBridge,
		private readonly visibility: VisibilityOperations,
		private readonly root: DirectoryRef,
		private readonly rootEntries: readonly NativeDirectoryEntry[],
		private readonly bypassVisibility: boolean,
		private readonly rootSkipped: boolean,
		private readonly options: TraversalOptions,
		private readonly context: FsOperationContext,
		private readonly resolveChild: ResolveTraversalChild<TChild>,
		private readonly createEntry: CreateTraversalEntry<TChild, TEntry>,
		private readonly rootEntry: TEntry | undefined,
		private readonly trackRelativePaths: boolean,
	) {}

	[Symbol.asyncIterator](): AsyncIterator<TraversalStreamEvent<TEntry>> {
		return this.iterate();
	}

	async close(): Promise<void> {
		this.stopped = true;
	}

	private async *iterate(): AsyncGenerator<TraversalStreamEvent<TEntry>> {
		if (this.consumed) {
			yield {
				type: "error",
				path: this.root.displayPath,
				error: { code: "invalid-path", message: "Traversal has already been consumed.", path: this.root.displayPath },
			};
			return;
		}
		this.consumed = true;
		try {
			if (this.context.signal?.aborted === true) {
				this.stopped = true;
				yield abortedEvent(this.root.displayPath);
				return;
			}
			if (this.rootSkipped) {
				yield { type: "skip", path: this.root.displayPath, reason: "ignored", kind: "directory" };
				return;
			}
			if (this.rootEntry !== undefined) yield this.rootEntry;
			yield* this.walkDirectory(this.root, this.rootEntries, 1, "");
		} finally {
			await this.close();
		}
	}

	private async *walkDirectory(
		directory: DirectoryRef,
		nativeEntries: readonly NativeDirectoryEntry[],
		depth: number,
		relativeDirectory: string,
	): AsyncGenerator<TraversalStreamEvent<TEntry>> {
		if (this.options.maxDepth !== undefined && depth > this.options.maxDepth) {
			if (nativeEntries.length > 0) yield { type: "skip", path: directory.displayPath, reason: "depth-limit", kind: "directory" };
			return;
		}
		const sorted = [...nativeEntries].sort((left, right) => compareLogicalPath(left.name, right.name));
		let start = 0;
		while (start < sorted.length) {
			if (this.stopped) return;
			if (this.context.signal?.aborted === true) {
				this.stopped = true;
				yield abortedEvent(directory.displayPath);
				return;
			}
			const batchSize = this.remainingBatchSize();
			const prepared = await Promise.all(sorted.slice(start, start + batchSize)
				.map(async (nativeEntry) => await this.prepareChild(directory, nativeEntry)));
			start += batchSize;
			for (const { nativeEntry, child, annotation, children } of prepared) {
				if (isContextAborted(this.context)) {
					this.stopped = true;
					yield abortedEvent(directory.displayPath);
					return;
				}
				if (!child.ok && child.error.code === "blocked") {
					yield { type: "skip", path: child.error.path ?? nativeEntry.name, reason: "blocked", kind: nativeEntry.kind };
					continue;
				}
				// Blocked entries are hidden from both traversal statistics and the caller's scan budget.
				if (this.options.maxEntries !== undefined && this.scannedEntries >= this.options.maxEntries) {
					this.stopped = true;
					yield { type: "skip", path: directory.displayPath, reason: "entry-limit", kind: "directory" };
					return;
				}
				this.scannedEntries += 1;
				if (!child.ok) {
					if (child.error.code === "aborted") this.stopped = true;
					yield { type: "error", path: child.error.path ?? nativeEntry.name, error: child.error, kind: nativeEntry.kind };
					if (this.stopped) return;
					continue;
				}
				const ref = child.value.ref;
				if (ref.kind === "symlink") {
					yield { type: "skip", path: ref.displayPath, reason: "symlink", kind: "symlink" };
					continue;
				}
				if (annotation === undefined) continue;
				if (!annotation.ok) {
					if (annotation.error.code === "aborted") this.stopped = true;
					yield { type: "error", path: ref.displayPath, error: annotation.error };
					if (this.stopped) return;
					continue;
				}
				if (annotation.value.ignored) {
					yield { type: "skip", path: ref.displayPath, reason: "ignored", kind: ref.kind };
					if (ref.kind !== "directory" || annotation.value.prune) continue;
				} else {
					const relativePath = this.childRelativePath(relativeDirectory, nativeEntry.name);
					yield this.createEntry(child.value, depth, annotation.value, relativePath);
				}
				if (ref.kind !== "directory") continue;
				const relativePath = this.childRelativePath(relativeDirectory, nativeEntry.name);
				if (children === undefined) continue;
				if (!children.ok) {
					if (children.error.code === "aborted") this.stopped = true;
					yield { type: "error", path: ref.displayPath, error: children.error };
					if (this.stopped) return;
					continue;
				}
				yield* this.walkDirectory(ref, children.value, depth + 1, relativePath);
			}
		}
	}

	private childRelativePath(parent: string, name: string): string {
		if (!this.trackRelativePaths) return "";
		return parent.length === 0 ? name : `${parent}/${name}`;
	}

	private remainingBatchSize(): number {
		if (this.options.maxEntries === undefined) return DIRECTORY_ENTRY_CONCURRENCY;
		return Math.max(1, Math.min(DIRECTORY_ENTRY_CONCURRENCY, this.options.maxEntries - this.scannedEntries));
	}

	private async prepareChild(directory: DirectoryRef, nativeEntry: NativeDirectoryEntry): Promise<{
		readonly nativeEntry: NativeDirectoryEntry;
		readonly child: FsResult<TChild>;
		readonly annotation?: FsResult<VisibilityAnnotation>;
		readonly children?: FsResult<readonly NativeDirectoryEntry[]>;
	}> {
		const child = await this.resolveChild(directory, nativeEntry, this.context);
		if (!child.ok || child.value.ref.kind === "symlink") return { nativeEntry, child };
		const annotation = this.bypassVisibility
			? fsSuccess(VISIBLE)
			: await this.visibility.evaluate(child.value.ref, this.options.intent, this.context);
		if (
			!annotation.ok
			|| child.value.ref.kind !== "directory"
			|| (annotation.value.ignored && annotation.value.prune)
		) return { nativeEntry, child, annotation };
		return {
			nativeEntry,
			child,
			annotation,
			children: await this.readDirectory(child.value.ref),
		};
	}

	private async readDirectory(directory: DirectoryRef): Promise<FsResult<readonly NativeDirectoryEntry[]>> {
		const identity = nativeIdentity(this.bridge, directory);
		if (!identity.ok) return identity;
		try {
			const entries = await this.native.readdir(identity.value.nativePath, this.context);
			if (this.bypassVisibility) return fsSuccess(entries);
			const prepared = await this.visibility.prepareDirectory(directory, entries, this.context);
			return prepared.ok ? fsSuccess(entries) : prepared;
		} catch (error) {
			return fsFailure(mapNativeError(error, directory.displayPath));
		}
	}
}

function validateOptions(root: DirectoryRef, options: TraversalOptions): FsResult<never> | undefined {
	if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0)) {
		return fsFailure({ code: "invalid-path", message: "Traversal entry limit must be a non-negative integer.", path: root.displayPath });
	}
	if (options.maxDepth !== undefined && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)) {
		return fsFailure({ code: "invalid-path", message: "Traversal depth limit must be a non-negative integer.", path: root.displayPath });
	}
	return undefined;
}

function entryEvent(
	child: ResolvedExistingPath,
	depth: number,
	visibility: VisibilityAnnotation,
): TraversalEntryEvent {
	return { type: "entry", ref: child.ref, metadata: child.metadata, depth, visibility };
}

function pathEntryEvent(
	child: PathTraversalChild,
	depth: number,
	visibility: VisibilityAnnotation,
	relativePath: string,
): PathTraversalEntryEvent {
	return { type: "entry", ref: child.ref, relativePath, depth, visibility };
}

function isContextAborted(context: FsOperationContext): boolean {
	return context.signal?.aborted === true;
}

function abortedEvent(path: string): TraversalErrorEvent {
	return { type: "error", path, error: { code: "aborted", message: "Operation aborted.", path } };
}
