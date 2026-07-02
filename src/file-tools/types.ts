/** 文件工具返回给模型的稳定错误码。 */
export type FileToolErrorCode =
	| "FILE_NOT_FOUND"
	| "FILE_ALREADY_EXISTS"
	| "PATH_OUTSIDE_WORKSPACE"
	| "SYMLINK_OUTSIDE_WORKSPACE"
	| "PROTECTED_PATH"
	| "INVALID_PATH"
	| "INVALID_OPERATION"
	| "CONFLICTING_OPERATIONS"
	| "BASE_VERSION_REQUIRED"
	| "STALE_BASE_VERSION"
	| "DIFF_PARSE_ERROR"
	| "DIFF_CONTEXT_NOT_FOUND"
	| "DIFF_CONTEXT_AMBIGUOUS"
	| "DIFF_OVERLAPPING_HUNKS"
	| "ENCODING_UNSUPPORTED"
	| "BINARY_FILE_UNSUPPORTED"
	| "OUTPUT_LIMIT_EXCEEDED"
	| "TRANSACTION_VALIDATION_FAILED"
	| "TRANSACTION_COMMIT_FAILED"
	| "TRANSACTION_ROLLBACK_FAILED";

/** 机器可读错误；message 只用于帮助模型和人类理解。 */
export interface FileToolError {
	code: FileToolErrorCode;
	message: string;
	path?: string;
	type?: EditOperationType;
	operation_index?: number;
	hunk?: number;
	expected?: string;
	actual?: string;
	details?: Record<string, unknown>;
}

export interface FailedResult {
	status: "failed";
	error: FileToolError;
}

export type ToolOutcome<T> = T | FailedResult;

export type NewlineKind = "lf" | "crlf" | "mixed" | "none";

export interface TextFile {
	bytes: Buffer;
	text: string;
	version: string;
	sizeBytes: number;
	totalLines: number;
	newline: NewlineKind;
	hasBom: boolean;
}

export interface ReadParams {
	path: string;
	start_line?: number;
	end_line?: number;
}

export interface ReadSuccess {
	path: string;
	content: string;
	start_line: number;
	end_line: number;
	total_lines: number;
	size_bytes: number;
	version: string;
	encoding: "utf-8";
	newline: NewlineKind;
	truncated: boolean;
	continuation?: { start_line: number };
	bom: boolean;
}

export type EditOperationType = "create_file" | "update_file" | "replace_file" | "delete_file" | "move_file";

export interface DiffHunk {
	index: number;
	oldLines: string[];
	newLines: string[];
}

export type EditOperation =
	| { type: "create_file"; path: string; content: string }
	| { type: "update_file"; path: string; base_version: string; diff: string }
	| { type: "replace_file"; path: string; base_version: string; content: string }
	| { type: "delete_file"; path: string; base_version: string }
	| { type: "move_file"; from: string; to: string; base_version: string };

export interface EditParams {
	operations: EditOperation[];
}

export interface OperationResult {
	index: number;
	type: EditOperationType;
	path?: string;
	from?: string;
	to?: string;
	old_version: string | null;
	new_version: string | null;
}

export interface EditSuccess {
	status: "applied";
	transaction_id: string;
	results: OperationResult[];
	diff: string;
}

export interface ResolvedPath {
	inputPath: string;
	relativePath: string;
	absolutePath: string;
	realPath: string;
}

export interface TargetPath {
	inputPath: string;
	relativePath: string;
	absolutePath: string;
	parentRealPath: string;
}
