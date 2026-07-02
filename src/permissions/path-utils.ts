import os from "node:os";
import path from "node:path";

import type { FileIdentity } from "./permission-types.js";

/** 路径比较统一走 realpath/resolve 后的组件边界，避免字符串前缀误判。 */
export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(normalizeCase(root), normalizeCase(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toSlashPath(value: string): string {
	return value.split(path.sep).join("/");
}

export function maybeWorkspaceRelative(workspaceRoot: string, candidate: string, allowRoot: boolean): string | undefined {
	if (!isPathInside(workspaceRoot, candidate)) return undefined;
	const relative = path.relative(workspaceRoot, candidate);
	if (relative === "") return allowRoot ? "." : undefined;
	return toSlashPath(relative);
}

export function normalizeUserPath(workspaceRoot: string, inputPath: string): string {
	const expanded = expandHome(inputPath);
	return path.resolve(workspaceRoot, expanded);
}

export function expandHome(inputPath: string): string {
	if (inputPath === "~") return os.homedir();
	if (inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith("~/")) {
		return path.join(os.homedir(), inputPath.slice(2));
	}
	return inputPath;
}

export function validatePathText(inputPath: string): string | undefined {
	if (typeof inputPath !== "string" || inputPath.trim() === "" || inputPath.includes("\0")) {
		return "Path must be a non-empty string without null bytes.";
	}
	if (/^[A-Za-z]:[^\\/]/.test(inputPath)) {
		return "Windows drive-relative paths are not allowed.";
	}
	if (/[<>|"*?{}]/.test(inputPath)) {
		return "Path contains unsupported wildcard or shell metacharacters.";
	}
	return undefined;
}

export function identityEquals(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
	if (left === undefined && right === undefined) return true;
	if (left === undefined || right === undefined) return false;
	return left.device === right.device && left.inode === right.inode;
}

export function normalizeCase(value: string): string {
	return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
}

export function pathDepth(value: string): number {
	const parsed = path.parse(path.resolve(value));
	const relative = path.relative(parsed.root, path.resolve(value));
	if (relative === "") return 0;
	return relative.split(path.sep).length;
}
