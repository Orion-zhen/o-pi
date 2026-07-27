import type { DirectoryRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import type {
	Traversal,
	TraversalEntryEvent,
	TraversalEvent,
	TraversalOperations,
	TraversalOptions,
} from "../contracts/traversal.js";
import type { VisibilityAnnotation, VisibilityOperations } from "../contracts/visibility.js";
import { mapNativeError } from "../kernel/native-error.js";
import type { ResolvedExistingPath, WorkspaceNamespaceBridge } from "../kernel/namespace.js";
import { bindOperationContext } from "../operation-context.js";
import type { NativeDirectoryEntry, NativeFileSystem } from "../platform/node/native-filesystem.js";
import { DIRECTORY_ENTRY_CONCURRENCY } from "./concurrency.js";
import { compareLogicalPath } from "./path-order.js";
import { nativeIdentity } from "./ref.js";

const VISIBLE: VisibilityAnnotation = { ignored: false, prune: false };

/** Deterministic, cancellable depth-first traversal with mandatory access and visibility gates. */
export class WorkspaceTraversalService implements TraversalOperations {
	constructor(
		private readonly native: NativeFileSystem,
		private readonly bridge: WorkspaceNamespaceBridge,
		private readonly visibility: VisibilityOperations,
		private readonly ownerSignal?: AbortSignal,
	) {}

	async walk(root: DirectoryRef, options: TraversalOptions, context: FsOperationContext): Promise<FsResult<Traversal>> {
		context = bindOperationContext(this.ownerSignal, context);
		if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0)) {
			return fsFailure({ code: "invalid-path", message: "Traversal entry limit must be a non-negative integer.", path: root.displayPath });
		}
		if (options.maxDepth !== undefined && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)) {
			return fsFailure({ code: "invalid-path", message: "Traversal depth limit must be a non-negative integer.", path: root.displayPath });
		}
		const rootIdentity = nativeIdentity(this.bridge, root);
		if (!rootIdentity.ok) return rootIdentity;
		const rootVisibility = await this.visibility.evaluate(root, options.intent, context);
		if (!rootVisibility.ok) return rootVisibility;
		const bypassVisibility = options.explicitRoot === true && rootVisibility.value.ignored;
		if (rootVisibility.value.ignored && !bypassVisibility) {
			return fsSuccess(new NativeTraversal(
				this.native,
				this.bridge,
				this.visibility,
				root,
				[],
				rootVisibility.value,
				undefined,
				false,
				true,
				options,
				context,
			));
		}

		let entries: readonly NativeDirectoryEntry[];
		let rootMetadata: Awaited<ReturnType<NativeFileSystem["stat"]>> | undefined;
		try {
			[entries, rootMetadata] = await Promise.all([
				this.native.readdir(rootIdentity.value.nativePath, context),
				options.includeRoot === true ? this.native.stat(rootIdentity.value.nativePath, context) : Promise.resolve(undefined),
			]);
		} catch (error) {
			return fsFailure(mapNativeError(error, root.displayPath));
		}
		return fsSuccess(new NativeTraversal(
			this.native,
			this.bridge,
			this.visibility,
			root,
			entries,
			rootVisibility.value,
			rootMetadata,
			bypassVisibility,
			false,
			options,
			context,
		));
	}
}

class NativeTraversal implements Traversal {
	private stopped = false;
	private consumed = false;
	private scannedEntries = 0;

	constructor(
		private readonly native: NativeFileSystem,
		private readonly bridge: WorkspaceNamespaceBridge,
		private readonly visibility: VisibilityOperations,
		private readonly root: DirectoryRef,
		private readonly rootEntries: readonly NativeDirectoryEntry[],
		private readonly rootVisibility: VisibilityAnnotation,
		private readonly rootMetadata: Awaited<ReturnType<NativeFileSystem["stat"]>> | undefined,
		private readonly bypassVisibility: boolean,
		private readonly rootSkipped: boolean,
		private readonly options: TraversalOptions,
		private readonly context: FsOperationContext,
	) {}

	[Symbol.asyncIterator](): AsyncIterator<TraversalEvent> {
		return this.iterate();
	}

	async close(): Promise<void> {
		this.stopped = true;
	}

	private async *iterate(): AsyncGenerator<TraversalEvent> {
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
			if (this.options.includeRoot === true && this.rootMetadata !== undefined) {
				yield { type: "entry", ref: this.root, metadata: this.rootMetadata, depth: 0, visibility: this.rootVisibility };
			}
			yield* this.walkDirectory(this.root, this.rootEntries, 1);
		} finally {
			await this.close();
		}
	}

	private async *walkDirectory(
		directory: DirectoryRef,
		nativeEntries: readonly NativeDirectoryEntry[],
		depth: number,
	): AsyncGenerator<TraversalEvent> {
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
			for (const { nativeEntry, child, annotation } of prepared) {
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
					yield entryEvent(ref, child.value.metadata, depth, annotation.value);
				}
				if (ref.kind !== "directory") continue;

				const identity = nativeIdentity(this.bridge, ref);
				if (!identity.ok) {
					yield { type: "error", path: ref.displayPath, error: identity.error };
					continue;
				}
				let children: readonly NativeDirectoryEntry[];
				try {
					children = await this.native.readdir(identity.value.nativePath, this.context);
				} catch (error) {
					const mapped = mapNativeError(error, ref.displayPath);
					if (mapped.code === "aborted") this.stopped = true;
					yield { type: "error", path: ref.displayPath, error: mapped };
					if (this.stopped) return;
					continue;
				}
				yield* this.walkDirectory(ref, children, depth + 1);
			}
		}
	}

	private remainingBatchSize(): number {
		if (this.options.maxEntries === undefined) return DIRECTORY_ENTRY_CONCURRENCY;
		return Math.max(1, Math.min(DIRECTORY_ENTRY_CONCURRENCY, this.options.maxEntries - this.scannedEntries));
	}

	private async prepareChild(directory: DirectoryRef, nativeEntry: NativeDirectoryEntry): Promise<{
		readonly nativeEntry: NativeDirectoryEntry;
		readonly child: FsResult<ResolvedExistingPath>;
		readonly annotation?: FsResult<VisibilityAnnotation>;
	}> {
		const child = await this.bridge.resolveChild(directory, nativeEntry.name, this.context);
		if (!child.ok || child.value.ref.kind === "symlink") return { nativeEntry, child };
		const annotation = this.bypassVisibility
			? fsSuccess(VISIBLE)
			: await this.visibility.evaluate(child.value.ref, this.options.intent, this.context);
		return { nativeEntry, child, annotation };
	}
}

function entryEvent(
	ref: TraversalEntryEvent["ref"],
	metadata: TraversalEntryEvent["metadata"],
	depth: number,
	visibility: VisibilityAnnotation,
): TraversalEntryEvent {
	return { type: "entry", ref, metadata, depth, visibility };
}

function isContextAborted(context: FsOperationContext): boolean {
	return context.signal?.aborted === true;
}

function abortedEvent(path: string): TraversalEvent {
	return { type: "error", path, error: { code: "aborted", message: "Operation aborted.", path } };
}
