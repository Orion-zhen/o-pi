import type { ExistingRef } from "./path.js";
import type { FsOperationContext, FsResult } from "./result.js";

export type VisibilityIntent =
	| "list-entry"
	| "traverse"
	| "search"
	| "index"
	| "explicit-read"
	| "explicit-edit";

export interface VisibilityAnnotation {
	readonly ignored: boolean;
	readonly prune: boolean;
	readonly source?: string;
	readonly rule?: string;
}

export interface VisibilitySnapshotInfo {
	readonly fingerprint: string;
	readonly diagnostics: readonly string[];
}

export interface VisibilityOperations {
	readonly snapshot: VisibilitySnapshotInfo;
	evaluate(ref: ExistingRef, intent: VisibilityIntent, context: FsOperationContext): Promise<FsResult<VisibilityAnnotation>>;
}
