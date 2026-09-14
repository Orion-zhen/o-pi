import path from "node:path";

/** 生成不依赖 cwd 或文件系统状态的索引内部路径。 */
export function normalizeIndexPath(filePath: string): string {
	return path.posix.normalize(filePath.replaceAll("\\", "/"));
}

export function createFileIdentity(filePath: string): { id: string; path: string } {
	const normalizedPath = normalizeIndexPath(filePath);
	return { id: `file:${normalizedPath}`, path: normalizedPath };
}

export function createSymbolId(input: { fileId: string; kind: string; symbolName: string; startByte: number }): string {
	return ["symbol", input.fileId, input.kind, input.symbolName, String(input.startByte)]
		.map((part) => encodeURIComponent(part))
		.join(":");
}
