import type { DirectoryRef, ExistingRef } from "./path.js";
import type { FsOperationContext, FsResult } from "./result.js";

export interface PathCatalogOptions {
	readonly limit: number;
	readonly maxEntries: number;
}

export interface PathCatalogCandidate {
	readonly ref: ExistingRef;
	readonly similarity: number;
}

export interface PathCatalogOperations {
	suggest(root: DirectoryRef, query: string, options: PathCatalogOptions, context: FsOperationContext): Promise<FsResult<readonly PathCatalogCandidate[]>>;
}
