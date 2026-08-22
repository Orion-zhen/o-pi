import type { DirectoryRef, ExistingPathKind, ExistingRef } from "./path.js";
import type { FsResult } from "./result.js";

export interface FileSnapshot {
	/** Stable identity of one filesystem object, independent of content changes. */
	readonly identity: string;
	/** Stable metadata stamp for one version of the object. */
	readonly version: string;
	readonly sizeBytes: number;
}

export interface FileMetadata extends FileSnapshot {
	readonly kind: ExistingPathKind;
	readonly modifiedAtMs: number;
}

/** Projects backend metadata into the public snapshot used to bind later content reads. */
export function toFileSnapshot(metadata: FileMetadata): FileSnapshot {
	return {
		identity: metadata.identity,
		version: metadata.version,
		sizeBytes: metadata.sizeBytes,
	};
}

export interface DirectoryEntry {
	readonly ref: ExistingRef;
	readonly name: string;
	readonly linkTarget?: string;
}

export interface MetadataOperations {
	stat(ref: ExistingRef): Promise<FsResult<FileMetadata>>;
	list(directory: DirectoryRef): Promise<FsResult<readonly DirectoryEntry[]>>;
}
