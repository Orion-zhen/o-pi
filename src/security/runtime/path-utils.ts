import os from "node:os";
import path from "node:path";

export interface FileIdentity {
	device?: number;
	inode?: number;
}

export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(normalizeCase(root), normalizeCase(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeCase(value: string): string {
	return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
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

export function expandConfiguredPath(inputPath: string, variables: { workspace: string; agentDir: string }): string {
	let expanded = expandHome(inputPath);
	expanded = expanded.replace(/\$\{([^}]+)\}/g, (_match, rawName: string) => {
		if (rawName === "workspace") return variables.workspace;
		if (rawName === "agentDir") return variables.agentDir;
		throw new Error(`Unknown path variable: \${${rawName}}`);
	});
	return path.resolve(variables.workspace, expanded);
}

export function normalizeUserPath(workspaceRoot: string, inputPath: string, agentDir: string): string {
	return path.resolve(workspaceRoot, expandConfiguredPath(inputPath, { workspace: workspaceRoot, agentDir }));
}

export function expandHome(inputPath: string): string {
	if (inputPath === "~") return os.homedir();
	if (inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
	return inputPath;
}

export function validatePathText(inputPath: string): string | undefined {
	if (typeof inputPath !== "string" || inputPath.trim() === "" || inputPath.includes("\0")) {
		return "Path must be a non-empty string without null bytes.";
	}
	if (/^[A-Za-z]:[^\\/]/.test(inputPath)) return "Windows drive-relative paths are not allowed.";
	if (/[<>|"*?{}]/.test(inputPath)) return "Path contains unsupported wildcard or shell metacharacters.";
	return undefined;
}

export function identityEquals(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
	if (left === undefined && right === undefined) return true;
	if (left === undefined || right === undefined) return false;
	if (left.device === undefined || left.inode === undefined || right.device === undefined || right.inode === undefined) return true;
	return left.device === right.device && left.inode === right.inode;
}

