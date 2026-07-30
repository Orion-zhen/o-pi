import path from "node:path";

import type { ApprovalEffect } from "./types.js";

const SYSTEM_PATH_PREFIXES = ["etc", "usr", "bin", "sbin", "System", "Library", "var"];

export function pathEffects(targetPath: string): ApprovalEffect[] {
	const effects: ApprovalEffect[] = ["write"];
	if (isSystemPath(targetPath)) effects.push("system_change");
	return effects;
}

export function normalizeTargetPath(filePath: string, cwd: string): string {
	const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
	return absolute.replace(/\\/g, "/");
}

function isSystemPath(targetPath: string): boolean {
	const normalized = targetPath.replace(/\\/g, "/");
	const root = path.parse(normalized).root;
	const relative = path.relative(root, normalized).replace(/\\/g, "/");
	return SYSTEM_PATH_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}
