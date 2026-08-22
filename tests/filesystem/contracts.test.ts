import { describe, expect, it } from "vitest";

import type { FsErrorCode } from "../../src/filesystem/contracts/result.js";
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

describe("filesystem contracts", () => {
	it.each(ERROR_MAPPINGS)("maps %s into %s", (fsCode, toolCode) => {
		const result = mapFsError({ code: fsCode, message: "neutral failure", path: "src/a.ts" });
		expect(result).toEqual({
			status: "failed",
			error: { code: toolCode, message: "neutral failure", path: "src/a.ts" },
		});
	});

	it("provides a fallback when the filesystem message is empty", () => {
		expect(mapFsError({ code: "invalid-path", message: "" }).error.message).not.toBe("");
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
