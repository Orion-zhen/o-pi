import path from "node:path";

import type { FileIdentity, SymbolIdentityInput } from "./types.js";

/** 持久索引格式版本；导入该常量不会加载 parser runtime 或 grammar。 */
export const CODE_INDEX_FORMAT_VERSION = "code-index-format-v2";

/** 生成不依赖 cwd 或文件系统状态的索引内部路径。 */
export function normalizeIndexPath(filePath: string): string {
	const slashPath = filePath.replace(/\\/gu, "/");
	const normalized = path.posix.normalize(slashPath);
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function createFileIdentity(filePath: string): FileIdentity {
	const normalizedPath = normalizeIndexPath(filePath);
	return { id: `file:${normalizedPath}`, path: normalizedPath };
}

export function createSymbolId(input: SymbolIdentityInput): string {
	const symbolName = input.qualifiedName ?? input.name ?? "";
	return ["symbol", input.fileId, input.kind, symbolName, String(input.startByte)]
		.map((part) => encodeURIComponent(part))
		.join(":");
}
