import type { FailedResult, FileToolError, FileToolErrorCode } from "../types.js";

/** 统一生成失败结果，避免工具返回形状漂移。 */
export function fail(
	code: FileToolErrorCode,
	message: string,
	options: {
		next?: string;
		path?: string;
		edit_index?: number;
		expected?: string;
		actual?: string;
		details?: Record<string, unknown>;
	} = {},
): FailedResult {
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
