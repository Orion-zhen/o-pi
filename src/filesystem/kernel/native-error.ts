import type { FsError } from "../contracts/result.js";
import { NativeFileSystemError } from "../platform/node/native-filesystem.js";

/** Maps platform failures into stable filesystem-layer errors. */
export function mapNativeError(error: unknown, displayPath: string): FsError {
	if (!(error instanceof NativeFileSystemError)) {
		return { code: "access-denied", message: "Path cannot be accessed.", path: displayPath };
	}
	if (error.code === "aborted") return { code: "aborted", message: "Operation aborted.", path: displayPath };
	if (error.code === "changed") return { code: "changed-during-read", message: "Path changed during access.", path: displayPath };
	if (error.code === "not-found") return { code: "not-found", message: "Path does not exist.", path: displayPath };
	if (error.code === "not-directory") {
		return { code: "not-directory", message: "Path component is not a directory.", path: displayPath };
	}
	if (error.code === "is-directory") return { code: "not-file", message: "Path is not a regular file.", path: displayPath };
	if (error.code === "invalid-path") return { code: "invalid-path", message: "Path is invalid.", path: displayPath };
	return { code: "access-denied", message: "Path cannot be accessed.", path: displayPath };
}

export function isNativeError(error: unknown, code: NativeFileSystemError["code"]): boolean {
	return error instanceof NativeFileSystemError && error.code === code;
}
