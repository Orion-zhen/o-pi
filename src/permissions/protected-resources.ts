import path from "node:path";

import type { PermissionAccess } from "./permission-types.js";
import { isPathInside } from "./path-utils.js";

export interface ProtectedResourceOptions {
	workspaceRoot: string;
	agentDir?: string;
	extraProtectedPaths?: string[];
}

/** 普通 edit 不得修改权限系统、策略文件或 Pi 信任/认证类状态。 */
export function isProtectedResource(canonicalPath: string, options: ProtectedResourceOptions): boolean {
	const roots = protectedRoots(options);
	return roots.some((root) => isPathInside(root, canonicalPath));
}

export function accessTouchesProtectedResource(access: PermissionAccess, options: ProtectedResourceOptions): boolean {
	return isProtectedResource(access.canonicalPath, options);
}

export function isHiddenWorkspaceMetadata(relativePath: string): boolean {
	return relativePath.split("/").some((segment) => segment === ".git");
}

function protectedRoots(options: ProtectedResourceOptions): string[] {
	const roots = [
		path.join(options.workspaceRoot, ".git"),
		path.join(options.workspaceRoot, ".pi", "permissions.jsonc"),
		path.join(options.workspaceRoot, ".pi", "permissions.schema.json"),
	];
	if (options.agentDir !== undefined) {
		roots.push(
			path.join(options.agentDir, "pi-permissions.jsonc"),
			path.join(options.agentDir, "permissions.schema.json"),
			path.join(options.agentDir, "extensions", "file-tools.ts"),
			path.join(options.agentDir, "extensions", "permissions.ts"),
			path.join(options.agentDir, "extensions", "permissions"),
			path.join(options.agentDir, "auth.json"),
			path.join(options.agentDir, "trust.json"),
		);
	}
	if (options.extraProtectedPaths !== undefined) roots.push(...options.extraProtectedPaths);
	return roots.map((root) => path.resolve(root));
}
