import type { FsError } from "../../filesystem/contracts/result.ts";

/** Stable model-visible file-tool error codes. */
export type FileToolErrorCode =
	| "FILE_NOT_FOUND"
	| "PATH_NOT_FOUND"
	| "NOT_A_FILE"
	| "NOT_A_DIRECTORY"
	| "PROTECTED_PATH"
	| "ACCESS_DENIED"
	| "CONFIG_ERROR"
	| "INVALID_PATH"
	| "INVALID_OPERATION"
	| "READ_REQUIRED"
	| "STALE_READ"
	| "OLD_TEXT_NOT_FOUND"
	| "OLD_TEXT_NOT_UNIQUE"
	| "OVERLAPPING_REPLACEMENTS"
	| "EDIT_VALIDATION_FAILED"
	| "ENCODING_UNSUPPORTED"
	| "BINARY_FILE_UNSUPPORTED"
	| "OUTPUT_LIMIT_EXCEEDED"
	| "OPERATION_ABORTED"
	| "INVALID_REGEX";

export interface FileToolError {
	code: FileToolErrorCode;
	message: string;
	next?: string;
	path?: string;
	edit_index?: number;
	expected?: string;
	actual?: string;
	details?: Record<string, unknown>;
	errors?: FileToolError[];
}

export interface FailedResult {
	status: "failed";
	error: FileToolError;
}

export type ToolOutcome<T> = T | FailedResult;

export type FailureOptions = Omit<FileToolError, "code" | "message">;

export function fail(code: FileToolErrorCode, message: string, options: FailureOptions = {}): FailedResult {
	return { status: "failed", error: { code, message, ...options } };
}

export function isFailed<T>(result: T | FailedResult): result is FailedResult {
	return typeof result === "object" && result !== null && "status" in result && result.status === "failed";
}

export interface FsErrorMappingOptions {
	readonly notFound?: "file" | "path";
	readonly path?: string;
	readonly next?: string;
	readonly message?: string;
}

/** Maps neutral filesystem failures into the existing file-tool protocol. */
export function mapFsError(error: FsError, options: FsErrorMappingOptions = {}): FailedResult {
	const code = fileToolCode(error, options.notFound ?? "path");
	const displayPath = options.path ?? error.path;
	const message = options.message ?? error.message;
	return fail(code, message, {
		...(displayPath !== undefined ? { path: displayPath } : {}),
		...(options.next !== undefined ? { next: options.next } : {}),
		...(error.details === undefined ? {} : { details: { ...error.details } }),
	});
}

function fileToolCode(error: FsError, notFound: "file" | "path"): FileToolErrorCode {
	switch (error.code) {
		case "invalid-path": return "INVALID_PATH";
		case "not-found": return notFound === "file" ? "FILE_NOT_FOUND" : "PATH_NOT_FOUND";
		case "not-file": return "NOT_A_FILE";
		case "not-directory": return "NOT_A_DIRECTORY";
		case "blocked": return "PROTECTED_PATH";
		case "access-denied":
		case "write-failed": return "ACCESS_DENIED";
		case "too-large": return "OUTPUT_LIMIT_EXCEEDED";
		case "invalid-utf8": return "ENCODING_UNSUPPORTED";
		case "binary": return "BINARY_FILE_UNSUPPORTED";
		case "aborted": return "OPERATION_ABORTED";
		case "changed-during-read": return "STALE_READ";
	}
}
