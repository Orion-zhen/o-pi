export type RepoMapErrorCode =
	| "NOT_GIT_WORKTREE"
	| "GIT_UNAVAILABLE"
	| "CONFIG_ERROR"
	| "SCAN_LIMIT_EXCEEDED"
	| "SCAN_FAILED"
	| "OPERATION_ABORTED"
	| "CACHE_ERROR"
	| "REPOSITORY_CHANGED_DURING_SCAN";

export class RepoMapError extends Error {
	constructor(readonly code: RepoMapErrorCode, message: string, readonly cause?: unknown) {
		super(message);
		this.name = "RepoMapError";
	}
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw new RepoMapError("OPERATION_ABORTED", "Repo Map initialization cancelled.");
}
