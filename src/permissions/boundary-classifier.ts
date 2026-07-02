import os from "node:os";
import path from "node:path";

import type { ResourceBoundary } from "./permission-types.js";
import { isPathInside } from "./path-utils.js";

export interface BoundaryClassifierOptions {
	workspaceRoot: string;
	agentDir?: string;
	extraSensitivePaths?: string[];
}

const POSIX_SYSTEM_ROOTS = ["/bin", "/sbin", "/usr", "/etc", "/proc", "/sys", "/dev", "/System", "/Library"];
const WIN_SYSTEM_ROOTS = ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];

/** 按 canonical path 组件分类资源边界；敏感路径优先于 workspace/external。 */
export function classifyBoundary(canonicalPath: string, options: BoundaryClassifierOptions): ResourceBoundary {
	const sensitive = sensitiveRoots(options);
	if (sensitive.some((root) => isPathInside(root, canonicalPath))) return "sensitive";
	const systemRoots = process.platform === "win32" ? WIN_SYSTEM_ROOTS : POSIX_SYSTEM_ROOTS;
	if (systemRoots.some((root) => isPathInside(root, canonicalPath))) return "system";
	return isPathInside(options.workspaceRoot, canonicalPath) ? "workspace" : "external";
}

export function sensitiveRoots(options: BoundaryClassifierOptions): string[] {
	const home = os.homedir();
	const roots = [
		path.join(home, ".ssh"),
		path.join(home, ".gnupg"),
		path.join(home, ".aws"),
		path.join(home, ".azure"),
		path.join(home, ".config", "gcloud"),
		path.join(home, "Library", "Application Support", "Google", "Chrome"),
		path.join(home, "AppData", "Local", "Google", "Chrome", "User Data"),
		path.join(options.workspaceRoot, ".git"),
		path.join(options.workspaceRoot, ".pi", "permissions.jsonc"),
	];
	if (options.agentDir !== undefined) {
		roots.push(
			path.join(options.agentDir, "pi-permissions.jsonc"),
			path.join(options.agentDir, "extensions", "file-tools.ts"),
			path.join(options.agentDir, "extensions", "permissions"),
			path.join(options.agentDir, "permissions.schema.json"),
		);
	}
	if (options.extraSensitivePaths !== undefined) roots.push(...options.extraSensitivePaths);
	return roots.map((root) => path.resolve(root));
}
