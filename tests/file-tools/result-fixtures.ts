import { expect } from "vitest";

import {
	isFailed,
	type FailedResult,
	type FileToolError,
	type ToolOutcome,
} from "../../src/file-tools/shared/result.js";

export function expectFailure<T>(
	result: ToolOutcome<T>,
	expected: FileToolError["code"] | Partial<FileToolError>,
): FailedResult {
	const error = typeof expected === "string" ? { code: expected } : expected;
	expect(result).toMatchObject({ status: "failed", error });
	if (!isFailed(result)) throw new Error("Expected file tool failure.");
	return result;
}
