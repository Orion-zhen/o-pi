import path from "node:path";

export function normalizeTargetPath(filePath: string, cwd: string): string {
	const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
	return absolute.replace(/\\/g, "/");
}
