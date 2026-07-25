export type FsErrorCode =
	| "invalid-path"
	| "not-found"
	| "not-file"
	| "not-directory"
	| "blocked"
	| "access-denied"
	| "too-large"
	| "invalid-utf8"
	| "binary"
	| "aborted"
	| "changed-during-read"
	| "write-failed";

/** Stable filesystem-layer failure without model-facing recovery text. */
export interface FsError {
	readonly code: FsErrorCode;
	readonly message: string;
	readonly path?: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

export type FsResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: FsError };

export interface FsOperationContext {
	readonly signal?: AbortSignal;
}

export function fsSuccess<T>(value: T): FsResult<T> {
	return { ok: true, value };
}

export function fsFailure(error: FsError): FsResult<never> {
	return { ok: false, error };
}
