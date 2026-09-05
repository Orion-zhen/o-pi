import type { FileSnapshot } from "./metadata.js";
import type { DirectoryRef, ExistingRef, FileRef } from "./path.js";
import type { FsError, FsResult } from "./result.js";
import type { VisibilityAnnotation } from "./visibility.js";

export type DiscoveryRoot = FileRef | DirectoryRef;
export type DiscoveryRef = FileRef | DirectoryRef;

export interface DiscoveryEntryEvent extends PathDiscoveryEntryEvent {
	readonly snapshot: FileSnapshot;
}

export interface PathDiscoveryEntryEvent {
	readonly type: "entry";
	readonly ref: DiscoveryRef;
	/** 相对原始 discovery root、以 `/` 规范化的路径。 */
	readonly relativePath: string;
	/** 相对原始 root 的深度。 */
	readonly depth: number;
	readonly visibility: VisibilityAnnotation;
}

export interface DiscoverySkipEvent {
	readonly type: "skip";
	readonly path: string;
	readonly reason: "blocked" | "ignored" | "symlink" | "entry-limit" | "depth-limit";
	readonly kind?: ExistingRef["kind"];
}

export interface DiscoveryErrorEvent {
	readonly type: "error";
	readonly path: string;
	readonly error: FsError;
	readonly kind?: ExistingRef["kind"];
}

export type DiscoveryEvent = DiscoveryEntryEvent | DiscoverySkipEvent | DiscoveryErrorEvent;
export type PathDiscoveryEvent = PathDiscoveryEntryEvent | DiscoverySkipEvent | DiscoveryErrorEvent;

export interface DiscoveryOptions {
	/** 相对 root 的安全 selector；不含 `/` 的 pattern 递归匹配 basename。 */
	readonly glob?: string;
	readonly maxDepth?: number;
	readonly maxEntries?: number;
}

export interface Discovery extends AsyncIterable<DiscoveryEvent> {
	close(): Promise<void>;
}

export interface PathDiscovery extends AsyncIterable<PathDiscoveryEvent> {
	close(): Promise<void>;
}

export interface DiscoveryOperations {
	discover(root: DiscoveryRoot, options: DiscoveryOptions): Promise<FsResult<Discovery>>;
	discoverPaths(root: DirectoryRef, options: DiscoveryOptions): Promise<FsResult<PathDiscovery>>;
}
