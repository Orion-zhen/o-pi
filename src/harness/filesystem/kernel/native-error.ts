import type { FsError } from "../contracts/result.ts";
import { NativeFileSystemError, type NativeFileSystemErrorCode } from "../platform/node/native-filesystem.ts";

const nativeCodes: Record<string, NativeFileSystemErrorCode> = {
	ENOENT: "not-found", ENOTDIR: "not-directory", EISDIR: "is-directory",
	EACCES: "access-denied", EPERM: "access-denied", EEXIST: "already-exists",
	EINVAL: "invalid-path", ENAMETOOLONG: "invalid-path", ELOOP: "invalid-path", ABORT_ERR: "aborted",
};

function errorCode(error: unknown): NativeFileSystemErrorCode | undefined {
	if (error instanceof NativeFileSystemError) return error.code;
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return nativeCodes[error.code] ?? ("syscall" in error ? "io-error" : undefined);
	}
}

/** 原生 I/O 错误只在文件系统边界转换，程序错误继续向上传播。 */
export function mapNativeError(error: unknown, path: string): FsError {
	switch (errorCode(error)) {
		case undefined: throw error;
		case "aborted": return { code: "aborted", message: "Operation aborted.", path };
		case "changed": return { code: "changed-during-read", message: "Path changed during access.", path };
		case "not-found": return { code: "not-found", message: "Path does not exist.", path };
		case "not-directory": return { code: "not-directory", message: "Path component is not a directory.", path };
		case "is-directory": return { code: "not-file", message: "Path is not a regular file.", path };
		case "invalid-path": return { code: "invalid-path", message: "Path is invalid.", path };
		default: return { code: "access-denied", message: "Path cannot be accessed.", path };
	}
}

export function isNativeError(error: unknown, code: NativeFileSystemErrorCode): boolean {
	return errorCode(error) === code;
}
