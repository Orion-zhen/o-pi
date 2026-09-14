import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/** 从 cwd 向上收集目录；位于 Git 仓库内时止于仓库根。 */
export function collectAncestorDirs(startDir: string, ...segments: string[]): string[] {
	const dirs: string[] = [];
	const gitRoot = findGitRepoRoot(startDir);
	let current = path.resolve(startDir);
	while (true) {
		dirs.push(path.join(current, ...segments));
		if (gitRoot !== undefined && current === gitRoot) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

export function safeRealpath(filePath: string): string | undefined {
	try {
		return realpathSync(filePath);
	} catch {
		return undefined;
	}
}

export function isPathInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function uniqueResolvedPaths(paths: string[]): string[] {
	const seen = new Set<string>();
	return paths.filter((item) => {
		const resolved = path.resolve(item);
		if (seen.has(resolved)) return false;
		seen.add(resolved);
		return true;
	});
}

function findGitRepoRoot(startDir: string): string | undefined {
	let current = path.resolve(startDir);
	while (true) {
		if (existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}
