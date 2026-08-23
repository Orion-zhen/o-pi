import os from "node:os";
import path from "node:path";

const SYSTEM_TEMPORARY_ROOTS = systemTemporaryRoots();

export function normalizeTargetPath(filePath: string, cwd: string): string {
	const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
	return absolute.replace(/\\/g, "/");
}

export function isSystemTemporaryDescendant(filePath: string): boolean {
	if (!path.isAbsolute(filePath)) return false;
	const target = comparablePath(normalizeTargetPath(filePath, path.parse(filePath).root));
	return SYSTEM_TEMPORARY_ROOTS.some((root) => {
		const comparableRoot = comparablePath(root);
		return target !== comparableRoot && target.startsWith(`${comparableRoot}/`);
	});
}

function systemTemporaryRoots(): readonly string[] {
	const roots = new Set<string>();
	if (process.platform === "win32") {
		roots.add(normalizeTargetPath(os.tmpdir(), path.parse(os.tmpdir()).root));
	} else {
		for (const root of ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]) {
			roots.add(normalizeTargetPath(root, "/"));
		}
		const runtimeRoot = normalizeTargetPath(os.tmpdir(), "/");
		if (process.platform === "darwin" && runtimeRoot.startsWith("/var/folders/")) roots.add(runtimeRoot);
	}
	return [...roots];
}

function comparablePath(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/u, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
