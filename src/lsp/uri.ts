import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 将本地路径转为标准 file URI，供 LSP textDocument 参数使用。 */
export function pathToFileUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).toString();
}

/** 将 file URI 转回本地路径；非 file URI 返回 undefined。 */
export function fileUriToPath(uri: string): string | undefined {
	try {
		const url = new URL(uri);
		if (url.protocol !== "file:") return undefined;
		return fileURLToPath(url);
	} catch {
		return undefined;
	}
}

export function workspaceRelativePath(workspaceRoot: string, filePath: string): string | undefined {
	const relative = path.relative(workspaceRoot, filePath);
	if (relative === "") return ".";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.replace(/\\/g, "/");
}
