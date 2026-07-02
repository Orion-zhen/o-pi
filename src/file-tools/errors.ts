import type { EditOperationType, FailedResult, FileToolError, FileToolErrorCode } from "./types.js";

/** 统一生成失败结果，避免工具返回形状漂移。 */
export function fail(
	code: FileToolErrorCode,
	message: string,
	options: {
		path?: string;
		type?: EditOperationType;
		operation_index?: number;
		hunk?: number;
		expected?: string;
		actual?: string;
		details?: Record<string, unknown>;
	} = {},
): FailedResult {
	const error: FileToolError = { code, message };
	if (options.path !== undefined) error.path = options.path;
	if (options.type !== undefined) error.type = options.type;
	if (options.operation_index !== undefined) error.operation_index = options.operation_index;
	if (options.hunk !== undefined) error.hunk = options.hunk;
	if (options.expected !== undefined) error.expected = options.expected;
	if (options.actual !== undefined) error.actual = options.actual;
	if (options.details !== undefined) error.details = options.details;
	return { status: "failed", error };
}

export function isFailed<T>(result: T | FailedResult): result is FailedResult {
	return typeof result === "object" && result !== null && "status" in result && result.status === "failed";
}
