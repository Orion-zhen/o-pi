import type { FsError } from "../../filesystem/contracts/result.js";

/** Stable model-visible file-tool error codes. */
export type FileToolErrorCode =
	| "FILE_NOT_FOUND"
	| "PATH_NOT_FOUND"
	| "NOT_A_FILE"
	| "NOT_A_DIRECTORY"
	| "PROTECTED_PATH"
	| "ACCESS_DENIED"
	| "CONFIG_ERROR"
	| "API_NOT_SUPPORTED"
	| "INVALID_PATH"
	| "INVALID_OPERATION"
	| "READ_REQUIRED"
	| "STALE_READ"
	| "EMPTY_OLD_TEXT"
	| "OLD_TEXT_NOT_FOUND"
	| "OLD_TEXT_NOT_UNIQUE"
	| "OVERLAPPING_REPLACEMENTS"
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
}

export interface FailedResult {
	status: "failed";
	error: FileToolError;
}

export type ToolOutcome<T> = T | FailedResult;

export interface FailureOptions {
	next?: string;
	path?: string;
	edit_index?: number;
	expected?: string;
	actual?: string;
	details?: Record<string, unknown>;
}

export function fail(code: FileToolErrorCode, message: string, options: FailureOptions = {}): FailedResult {
	const error: FileToolError = { code, message };
	if (options.next !== undefined) error.next = options.next;
	if (options.path !== undefined) error.path = options.path;
	if (options.edit_index !== undefined) error.edit_index = options.edit_index;
	if (options.expected !== undefined) error.expected = options.expected;
	if (options.actual !== undefined) error.actual = options.actual;
	if (options.details !== undefined) error.details = options.details;
	return { status: "failed", error };
}

export function isFailed<T>(result: T | FailedResult): result is FailedResult {
	return typeof result === "object" && result !== null && "status" in result && result.status === "failed";
}

export interface FsErrorMappingOptions {
	readonly notFound?: "file" | "path";
	readonly path?: string;
	readonly next?: string;
	readonly message?: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

/** Maps neutral filesystem failures into the existing file-tool protocol. */
export function mapFsError(error: FsError, options: FsErrorMappingOptions = {}): FailedResult {
	const code = fileToolCode(error, options.notFound ?? "path");
	const details = mergeDetails(error.details, options.details);
	const displayPath = options.path ?? error.path;
	const message = options.message ?? (error.message.length > 0 ? error.message : defaultMessage(code));
	return fail(code, message, {
		...(displayPath !== undefined ? { path: displayPath } : {}),
		...(options.next !== undefined ? { next: options.next } : {}),
		...(details !== undefined ? { details } : {}),
	});
}

export function isAccessDenied(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}

type MappedFsErrorCode =
	| "FILE_NOT_FOUND"
	| "PATH_NOT_FOUND"
	| "NOT_A_FILE"
	| "NOT_A_DIRECTORY"
	| "PROTECTED_PATH"
	| "ACCESS_DENIED"
	| "INVALID_PATH"
	| "ENCODING_UNSUPPORTED"
	| "BINARY_FILE_UNSUPPORTED"
	| "OUTPUT_LIMIT_EXCEEDED"
	| "OPERATION_ABORTED"
	| "STALE_READ";

function fileToolCode(error: FsError, notFound: "file" | "path"): MappedFsErrorCode {
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

function defaultMessage(code: MappedFsErrorCode): string {
	switch (code) {
		case "FILE_NOT_FOUND": return "File does not exist.";
		case "PATH_NOT_FOUND": return "Path does not exist.";
		case "NOT_A_FILE": return "Path is not a regular file.";
		case "NOT_A_DIRECTORY": return "Path is not a directory.";
		case "PROTECTED_PATH": return "Path is protected.";
		case "ACCESS_DENIED": return "Path cannot be accessed.";
		case "INVALID_PATH": return "Path is invalid.";
		case "ENCODING_UNSUPPORTED": return "Only valid UTF-8 text is supported.";
		case "BINARY_FILE_UNSUPPORTED": return "Binary files are not supported.";
		case "OUTPUT_LIMIT_EXCEEDED": return "File exceeds the configured limit.";
		case "OPERATION_ABORTED": return "Operation aborted.";
		case "STALE_READ": return "File changed during the operation.";
	}
}

function mergeDetails(
	left: Readonly<Record<string, unknown>> | undefined,
	right: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
	if (left === undefined && right === undefined) return undefined;
	return { ...left, ...right };
}
