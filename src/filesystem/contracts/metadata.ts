import type { DirectoryRef, ExistingPathKind, ExistingRef } from "./path.js";
import type { FsOperationContext, FsResult } from "./result.js";

export interface FileMetadata {
	readonly kind: ExistingPathKind;
	/** Stable identity of one filesystem object when the backend can provide it. */
	readonly identity?: string;
	readonly sizeBytes: number;
	readonly modifiedAtMs: number;
	readonly version?: string;
}

export interface DirectoryEntry {
	readonly ref: ExistingRef;
	readonly name: string;
	readonly linkTarget?: string;
}

export interface MetadataOperations {
	stat(ref: ExistingRef, context: FsOperationContext): Promise<FsResult<FileMetadata>>;
	list(directory: DirectoryRef, context: FsOperationContext): Promise<FsResult<readonly DirectoryEntry[]>>;
}
