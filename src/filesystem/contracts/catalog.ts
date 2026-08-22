import type { DirectoryRef, FileRef } from "./path.js";
import type { FsResult } from "./result.js";

export interface PathCatalogOptions {
	readonly limit: number;
	readonly maxEntries: number;
}

export interface PathCatalogCandidate {
	readonly ref: FileRef;
	readonly similarity: number;
}

export interface PathCatalogOperations {
	suggest(root: DirectoryRef, query: string, options: PathCatalogOptions): Promise<FsResult<readonly PathCatalogCandidate[]>>;
}
