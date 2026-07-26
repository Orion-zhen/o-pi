import type { DirectoryRef, ExistingPathKind, ExistingRef } from "./path.js";
import type { FsOperationContext, FsResult } from "./result.js";

export interface PathCatalogOptions {
	readonly limit: number;
	readonly maxEntries: number;
	/** Defaults to regular files, matching missing-file suggestion semantics. */
	readonly kinds?: readonly ExistingPathKind[];
}

export interface PathCatalogCandidate {
	readonly ref: ExistingRef;
	readonly similarity: number;
}

export interface PathCatalogOperations {
	suggest(root: DirectoryRef, query: string, options: PathCatalogOptions, context: FsOperationContext): Promise<FsResult<readonly PathCatalogCandidate[]>>;
}
