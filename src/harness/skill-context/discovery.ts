import { statSync } from "node:fs";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { collectAncestorDirs } from "../resource-paths.js";

export interface ProjectSkillDiscoveryOptions {
	cwd: string;
	projectTrusted: boolean;
}

/** 补充 Pi 未覆盖的祖先 .pi/skills；cwd 自身仍由 Pi 原生发现。 */
export function discoverAncestorPiSkillPaths(options: ProjectSkillDiscoveryOptions): string[] {
	if (!options.projectTrusted) return [];
	const [, ...ancestorPaths] = collectAncestorDirs(options.cwd, CONFIG_DIR_NAME, "skills");
	return ancestorPaths.filter(isDirectory);
}

function isDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}
