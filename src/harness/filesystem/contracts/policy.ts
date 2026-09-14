import type { VisibilityPolicy } from "./visibility.ts";

/** Filesystem policy selected from user and invocation-cwd project configuration. */
export interface FilesystemPolicy {
	readonly blockedPaths: readonly string[];
	readonly visibility: VisibilityPolicy;
	readonly fingerprint: string;
}
