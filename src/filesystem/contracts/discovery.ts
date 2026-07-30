import type { FileSnapshot } from "./metadata.js";
import type { DirectoryRef, ExistingRef, FileRef } from "./path.js";
import type { FsError, FsOperationContext, FsResult } from "./result.js";
import type { TraversalSkipReason } from "./traversal.js";
import type { VisibilityAnnotation, VisibilityIntent } from "./visibility.js";

export type DiscoveryRoot = FileRef | DirectoryRef;
export type DiscoveryEntryKind = "file" | "directory";

export interface DiscoveryEntryEvent {
	readonly type: "entry";
	readonly ref: ExistingRef;
	/** 相对原始 discovery root、以 `/` 规范化的路径。 */
	readonly relativePath: string;
	/** 相对原始 root 的深度；显式文件 root 深度为 0。 */
	readonly depth: number;
	readonly snapshot: FileSnapshot;
	readonly visibility: VisibilityAnnotation;
}

export interface PathDiscoveryEntryEvent {
	readonly type: "entry";
	readonly ref: ExistingRef;
	/** 相对原始 discovery root、以 `/` 规范化的路径。 */
	readonly relativePath: string;
	/** 相对原始 root 的深度。 */
	readonly depth: number;
	readonly visibility: VisibilityAnnotation;
}

export interface DiscoverySkipEvent {
	readonly type: "skip";
	readonly path: string;
	readonly reason: TraversalSkipReason;
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
	readonly intent: VisibilityIntent;
	/** 相对 root 的安全 selector；不含 `/` 的 pattern 递归匹配 basename。 */
	readonly glob?: string;
	/** 省略时返回普通文件和目录。 */
	readonly kind?: DiscoveryEntryKind;
	readonly maxDepth?: number;
	readonly maxEntries?: number;
	/** 允许调用方显式选择的 ignored root。 */
	readonly explicitRoot?: boolean;
}

export interface Discovery extends AsyncIterable<DiscoveryEvent> {
	close(): Promise<void>;
}

export interface PathDiscovery extends AsyncIterable<PathDiscoveryEvent> {
	close(): Promise<void>;
}

export interface DiscoveryOperations {
	discover(root: DiscoveryRoot, options: DiscoveryOptions, context: FsOperationContext): Promise<FsResult<Discovery>>;
	discoverPaths(root: DirectoryRef, options: DiscoveryOptions, context: FsOperationContext): Promise<FsResult<PathDiscovery>>;
}
