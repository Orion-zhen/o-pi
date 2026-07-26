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
import type { WorkspaceNamespaceBridge } from "../kernel/namespace.js";
import type { NativeDirectoryEntry, NativeFileSystem } from "../platform/node/native-filesystem.js";
import { compareLogicalPath } from "./path-order.js";
import { nativeIdentity } from "./ref.js";

const VISIBLE: VisibilityAnnotation = { ignored: false, prune: false };

/** Deterministic, cancellable depth-first traversal with mandatory access and visibility gates. */
export class WorkspaceTraversalService implements TraversalOperations {
	constructor(
		private readonly native: NativeFileSystem,
		private readonly bridge: WorkspaceNamespaceBridge,
		private readonly visibility: VisibilityOperations,
	) {}

	async walk(root: DirectoryRef, options: TraversalOptions, context: FsOperationContext): Promise<FsResult<Traversal>> {
		if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0)) {
			return fsFailure({ code: "invalid-path", message: "Traversal entry limit must be a non-negative integer.", path: root.displayPath });
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
				false,
				true,
				options,
				context,
			));
		}

		let entries: readonly NativeDirectoryEntry[];
		try {
			entries = await this.native.readdir(rootIdentity.value.nativePath, context);
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
			if (this.rootSkipped) {
				yield { type: "skip", path: this.root.displayPath, reason: "ignored" };
				return;
			}
			if (this.options.includeRoot === true) {
				yield { type: "entry", ref: this.root, depth: 0, visibility: this.rootVisibility };
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
		for (const nativeEntry of [...nativeEntries].sort((left, right) => compareLogicalPath(left.name, right.name))) {
			if (this.stopped) return;
			if (this.context.signal?.aborted === true) {
				this.stopped = true;
				yield abortedEvent(directory.displayPath);
				return;
			}
			if (this.options.maxEntries !== undefined && this.scannedEntries >= this.options.maxEntries) {
				this.stopped = true;
				yield { type: "skip", path: directory.displayPath, reason: "entry-limit" };
				return;
			}
			this.scannedEntries += 1;

			const child = await this.bridge.resolveChild(directory, nativeEntry.name, this.context);
			if (!child.ok) {
				if (child.error.code === "blocked") {
					yield { type: "skip", path: child.error.path ?? nativeEntry.name, reason: "blocked" };
					continue;
				}
				if (child.error.code === "aborted") this.stopped = true;
				yield { type: "error", path: child.error.path ?? nativeEntry.name, error: child.error };
				if (this.stopped) return;
				continue;
			}
			if (child.value.kind === "symlink") {
				yield { type: "skip", path: child.value.displayPath, reason: "symlink" };
				continue;
			}

			const annotation = this.bypassVisibility
				? fsSuccess(VISIBLE)
				: await this.visibility.evaluate(child.value, this.options.intent, this.context);
			if (!annotation.ok) {
				if (annotation.error.code === "aborted") this.stopped = true;
				yield { type: "error", path: child.value.displayPath, error: annotation.error };
				if (this.stopped) return;
				continue;
			}
			if (annotation.value.ignored) {
				yield { type: "skip", path: child.value.displayPath, reason: "ignored" };
				if (child.value.kind !== "directory" || annotation.value.prune) continue;
			} else {
				yield entryEvent(child.value, depth, annotation.value);
			}
			if (child.value.kind !== "directory") continue;

			const identity = nativeIdentity(this.bridge, child.value);
			if (!identity.ok) {
				yield { type: "error", path: child.value.displayPath, error: identity.error };
				continue;
			}
			let children: readonly NativeDirectoryEntry[];
			try {
				children = await this.native.readdir(identity.value.nativePath, this.context);
			} catch (error) {
				const mapped = mapNativeError(error, child.value.displayPath);
				if (mapped.code === "aborted") this.stopped = true;
				yield { type: "error", path: child.value.displayPath, error: mapped };
				if (this.stopped) return;
				continue;
			}
			yield* this.walkDirectory(child.value, children, depth + 1);
		}
	}
}

function entryEvent(
	ref: TraversalEntryEvent["ref"],
	depth: number,
	visibility: VisibilityAnnotation,
): TraversalEntryEvent {
	return { type: "entry", ref, depth, visibility };
}

function abortedEvent(path: string): TraversalEvent {
	return { type: "error", path, error: { code: "aborted", message: "Operation aborted.", path } };
}
