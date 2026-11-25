import os from "node:os";
import path from "node:path";

const temporaryRoot = resolveTemporaryRoot(os.tmpdir());

export function rulePath(nativePath: string): string {
	return path.sep === "\\" ? nativePath.replaceAll("\\", "/") : nativePath;
}

export function normalizeTargetPath(filePath: string, cwd: string): string {
	return rulePath(path.resolve(cwd, filePath));
}

/** Windows Bash 的单根路径可能挂载在任意位置，不能用当前盘符补全。 */
export function isUnmappedBashPath(value: string): boolean {
	if (path.sep !== "\\") return false;
	const normalized = value.replaceAll("\\", "/");
	if (normalized.startsWith("/")) return !/^\/\/[^/?.][^/]*\/[^/]+(?:\/|$)/u.test(normalized);
	return /^[a-z]:(?!\/)/iu.test(normalized);
}

function resolveTemporaryRoot(value: string): string | undefined {
	if (!path.isAbsolute(value) || isUnmappedBashPath(value)) return undefined;
	const root = path.resolve(value);
	return path.dirname(root) === root ? undefined : root;
}

export function isSystemTemporaryDescendant(filePath: string): boolean {
	if (temporaryRoot === undefined || !path.isAbsolute(filePath)) return false;
	const relative = path.relative(temporaryRoot, filePath);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
