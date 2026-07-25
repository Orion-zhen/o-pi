import { describe, expect, it } from "vitest";

import { fsFailure, fsSuccess, type FsErrorCode } from "../../src/filesystem/contracts/result.js";
import { mapFsError, type FileToolErrorCode } from "../../src/file-tools/shared/result.js";

const ERROR_MAPPINGS: ReadonlyArray<readonly [FsErrorCode, FileToolErrorCode]> = [
	["invalid-path", "INVALID_PATH"],
	["not-found", "PATH_NOT_FOUND"],
	["not-file", "NOT_A_FILE"],
	["not-directory", "NOT_A_DIRECTORY"],
	["blocked", "PROTECTED_PATH"],
	["access-denied", "ACCESS_DENIED"],
	["too-large", "OUTPUT_LIMIT_EXCEEDED"],
	["invalid-utf8", "ENCODING_UNSUPPORTED"],
	["binary", "BINARY_FILE_UNSUPPORTED"],
	["aborted", "OPERATION_ABORTED"],
	["changed-during-read", "STALE_READ"],
	["write-failed", "ACCESS_DENIED"],
];

const DEFAULT_MESSAGES: ReadonlyArray<readonly [FsErrorCode, string]> = [
	["invalid-path", "Path is invalid."],
	["not-found", "Path does not exist."],
	["not-file", "Path is not a regular file."],
	["not-directory", "Path is not a directory."],
	["blocked", "Path is protected."],
	["access-denied", "Path cannot be accessed."],
	["too-large", "File exceeds the configured limit."],
	["invalid-utf8", "Only valid UTF-8 text is supported."],
	["binary", "Binary files are not supported."],
	["aborted", "Operation aborted."],
	["changed-during-read", "File changed during the operation."],
	["write-failed", "Path cannot be accessed."],
];

describe("filesystem contracts", () => {
	it("constructs discriminated success and failure results", () => {
		expect(fsSuccess(3)).toEqual({ ok: true, value: 3 });
		expect(fsFailure({ code: "aborted", message: "cancelled" })).toEqual({
			ok: false,
			error: { code: "aborted", message: "cancelled" },
		});
	});

	it.each(ERROR_MAPPINGS)("maps %s into %s", (fsCode, toolCode) => {
		const result = mapFsError({ code: fsCode, message: "neutral failure", path: "src/a.ts" });
		expect(result).toEqual({
			status: "failed",
			error: { code: toolCode, message: "neutral failure", path: "src/a.ts" },
		});
	});

	it.each(DEFAULT_MESSAGES)("provides a stable default message for %s", (fsCode, message) => {
		expect(mapFsError({ code: fsCode, message: "" }).error.message).toBe(message);
	});

	it("applies operation-specific not-found semantics and recovery context", () => {
		expect(mapFsError({ code: "not-found", message: "" }, { notFound: "file" }).error.message).toBe("File does not exist.");
		const result = mapFsError(
			{ code: "not-found", message: "missing", path: "native-path", details: { source: "namespace", shared: "fs" } },
			{ notFound: "file", path: "display-path", next: "Read an existing file.", details: { shared: "tool" } },
		);
		expect(result).toEqual({
			status: "failed",
			error: {
				code: "FILE_NOT_FOUND",
				message: "missing",
				path: "display-path",
				next: "Read an existing file.",
				details: { source: "namespace", shared: "tool" },
			},
		});
	});
});
