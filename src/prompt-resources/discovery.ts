import { existsSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PromptResourceDiscoveryOptions {
	cwd: string;
	projectTrusted: boolean;
}

export function discoverAgentsPromptPaths(options: PromptResourceDiscoveryOptions): string[] {
	const userPromptsDir = path.join(os.homedir(), ".agents", "prompts");
	const paths = [...loadPromptFilesFromDir(userPromptsDir, undefined)];
	if (options.projectTrusted) {
		for (const dir of collectAncestorAgentsPromptDirs(options.cwd).filter((candidate) => path.resolve(candidate) !== path.resolve(userPromptsDir))) {
			paths.push(...loadPromptFilesFromDir(dir, dir));
		}
	}
	return uniquePaths(paths);
}

function collectAncestorAgentsPromptDirs(startDir: string): string[] {
	const dirs: string[] = [];
	const gitRoot = findGitRepoRoot(startDir);
	let current = path.resolve(startDir);
	while (true) {
		dirs.push(path.join(current, ".agents", "prompts"));
		if (gitRoot !== undefined && current === gitRoot) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function loadPromptFilesFromDir(dir: string, containmentRoot: string | undefined): string[] {
	if (!existsSync(dir)) return [];
	const rootReal = containmentRoot === undefined ? undefined : safeRealpath(containmentRoot);
	if (containmentRoot !== undefined && rootReal === undefined) return [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		if (rootReal !== undefined) {
			const real = safeRealpath(filePath);
			if (real === undefined || !isPathInside(real, rootReal)) continue;
		}
		files.push(filePath);
	}
	return files;
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

function safeRealpath(filePath: string): string | undefined {
	try {
		return realpathSync(filePath);
	} catch {
		return undefined;
	}
}

function isPathInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of paths) {
		const resolved = path.resolve(item);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		result.push(item);
	}
	return result;
}
