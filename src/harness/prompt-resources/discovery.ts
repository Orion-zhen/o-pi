import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAncestorDirs, isPathInside, safeRealpath, uniqueResolvedPaths } from "../resource-paths.js";

export interface PromptResourceDiscoveryOptions {
	cwd: string;
	projectTrusted: boolean;
}

export function discoverAgentsPromptPaths(options: PromptResourceDiscoveryOptions): string[] {
	const userPromptsDir = path.join(os.homedir(), ".agents", "prompts");
	const paths = [...loadPromptFilesFromDir(userPromptsDir, undefined)];
	if (options.projectTrusted) {
		for (const dir of collectAncestorDirs(options.cwd, ".agents", "prompts").filter((candidate) => path.resolve(candidate) !== path.resolve(userPromptsDir))) {
			paths.push(...loadPromptFilesFromDir(dir, dir));
		}
	}
	return uniqueResolvedPaths(paths);
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
