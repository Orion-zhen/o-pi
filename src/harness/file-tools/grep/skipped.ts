import type { FsError } from "../../filesystem/contracts/result.js";
import type { GrepSkippedFiles } from "./types.js";

export type MutableGrepSkippedFiles = Required<GrepSkippedFiles>;

export function createGrepSkippedFiles(): MutableGrepSkippedFiles {
	return { binary: 0, invalid_utf8: 0, access_denied: 0, too_large: 0, changed: 0 };
}

/** 记录已知的可跳过文件读取错误，并返回是否完成记录。 */
export function recordSkippedFile(stats: MutableGrepSkippedFiles, error: FsError): boolean {
	switch (error.code) {
		case "binary": stats.binary += 1; return true;
		case "invalid-utf8": stats.invalid_utf8 += 1; return true;
		case "access-denied": stats.access_denied += 1; return true;
		case "too-large": stats.too_large += 1; return true;
		case "changed-during-read":
		case "not-found":
		case "not-file": stats.changed += 1; return true;
		default: return false;
	}
}

export function compactGrepSkippedFiles(stats: GrepSkippedFiles): GrepSkippedFiles {
	const { binary = 0, invalid_utf8 = 0, access_denied = 0, too_large = 0, changed = 0 } = stats;
	const result: GrepSkippedFiles = {};
	if (binary > 0) result.binary = binary;
	if (invalid_utf8 > 0) result.invalid_utf8 = invalid_utf8;
	if (access_denied > 0) result.access_denied = access_denied;
	if (too_large > 0) result.too_large = too_large;
	if (changed > 0) result.changed = changed;
	return result;
}

export function mergeGrepSkippedFiles(values: readonly GrepSkippedFiles[]): GrepSkippedFiles {
	const result = createGrepSkippedFiles();
	for (const value of values) {
		result.binary += value.binary ?? 0;
		result.invalid_utf8 += value.invalid_utf8 ?? 0;
		result.access_denied += value.access_denied ?? 0;
		result.too_large += value.too_large ?? 0;
		result.changed += value.changed ?? 0;
	}
	return compactGrepSkippedFiles(result);
}
