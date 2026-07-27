import type { FileMetadata } from "./metadata.js";
import type { DirectoryRef, ExistingRef } from "./path.js";
import type { FsError, FsOperationContext, FsResult } from "./result.js";
import type { VisibilityAnnotation, VisibilityIntent } from "./visibility.js";

export type TraversalSkipReason = "blocked" | "ignored" | "symlink" | "entry-limit" | "depth-limit";

export interface TraversalEntryEvent {
	readonly type: "entry";
	readonly ref: ExistingRef;
	/** Metadata captured by the same guarded resolution that created ref. */
	readonly metadata: FileMetadata;
	readonly depth: number;
	readonly visibility: VisibilityAnnotation;
}

export interface TraversalSkipEvent {
	readonly type: "skip";
	readonly path: string;
	readonly reason: TraversalSkipReason;
	readonly kind?: ExistingRef["kind"];
}

export interface TraversalErrorEvent {
	readonly type: "error";
	readonly path: string;
	readonly error: FsError;
	readonly kind?: ExistingRef["kind"];
}

export type TraversalEvent = TraversalEntryEvent | TraversalSkipEvent | TraversalErrorEvent;

export interface TraversalOptions {
	readonly intent: VisibilityIntent;
	readonly includeRoot?: boolean;
	readonly explicitRoot?: boolean;
	readonly maxEntries?: number;
	/** 相对 traversal root；root 为 0，直属子项为 1。 */
	readonly maxDepth?: number;
}

export interface Traversal extends AsyncIterable<TraversalEvent> {
	close(): Promise<void>;
}

export interface TraversalOperations {
	walk(root: DirectoryRef, options: TraversalOptions, context: FsOperationContext): Promise<FsResult<Traversal>>;
}
