import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { fail } from "./errors.js";
import type { FailedResult, ResolvedPath, TargetPath, ToolOutcome } from "./types.js";
import { FileResolver, FileResolveError } from "../security/runtime/file-resolver.js";
import { maybeWorkspaceRelative } from "../security/runtime/path-utils.js";

/** workspace root 仍取真实路径；路径是否允许访问由权限系统决定。 */
export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
	return await realpath(cwd);
}

/** 解析已存在目录；允许 workspace 外路径，返回 canonical real path。 */
export async function resolveExistingDirectory(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<ResolvedPath>> {
	const resolved = await resolvePermissionPath(workspaceRoot, inputPath);
	if (isFailed(resolved)) return resolved;
	const shown = displayPath(workspaceRoot, resolved);
	if (isProtectedWorkspacePath(shown)) return fail("PERMISSION_DENIED", "Protected workspace metadata cannot be listed.", { path: shown });
	if (!resolved.exists) return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: displayPath(workspaceRoot, resolved) });
	const info = await stat(resolved.canonicalPath);
	if (!info.isDirectory()) return fail("NOT_A_DIRECTORY", "Path is not a directory.", { path: displayPath(workspaceRoot, resolved) });
	return {
		inputPath,
		relativePath: displayPath(workspaceRoot, resolved),
		absolutePath: resolved.lexicalAbsolutePath,
		realPath: resolved.canonicalPath,
	};
}

/** 解析已存在普通文件；允许 workspace 外路径，返回 canonical real path。 */
export async function resolveExistingFile(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<ResolvedPath>> {
	const resolved = await resolvePermissionPath(workspaceRoot, inputPath);
	if (isFailed(resolved)) return resolved;
	const shown = displayPath(workspaceRoot, resolved);
	if (isProtectedWorkspacePath(shown)) return fail("PERMISSION_DENIED", "Protected workspace metadata cannot be read.", { path: shown });
	if (!resolved.exists) return fail("FILE_NOT_FOUND", "File does not exist.", { path: displayPath(workspaceRoot, resolved) });
	const info = await stat(resolved.canonicalPath);
	if (!info.isFile()) return fail("NOT_A_FILE", "Path is not a regular file.", { path: displayPath(workspaceRoot, resolved) });
	return {
		inputPath,
		relativePath: displayPath(workspaceRoot, resolved),
		absolutePath: resolved.lexicalAbsolutePath,
		realPath: resolved.canonicalPath,
	};
}

/** 解析可创建或替换目标；不存在路径通过最近存在父目录 canonical 化。 */
export async function resolveTargetFile(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<TargetPath>> {
	const resolved = await resolvePermissionPath(workspaceRoot, inputPath);
	if (isFailed(resolved)) return resolved;
	if (maybeWorkspaceRelative(workspaceRoot, resolved.canonicalPath, true) === ".") {
		return fail("INVALID_PATH", "Target must be a file path, not the workspace root.", { path: inputPath });
	}
	const parentRealPath = resolved.exists ? await realpath(path.dirname(resolved.canonicalPath)) : resolved.canonicalParentPath;
	if (parentRealPath === undefined) return fail("PATH_NOT_FOUND", "Parent directory does not exist.", { path: displayPath(workspaceRoot, resolved) });
	const parentStat = await stat(parentRealPath);
	if (!parentStat.isDirectory()) return fail("INVALID_PATH", "Parent path is not a directory.", { path: displayPath(workspaceRoot, resolved) });
	return {
		inputPath,
		relativePath: displayPath(workspaceRoot, resolved),
		absolutePath: resolved.lexicalAbsolutePath,
		parentRealPath,
	};
}

export async function fileExists(absolutePath: string): Promise<boolean> {
	try {
		const result = await lstat(absolutePath);
		return result.isFile() || result.isSymbolicLink();
	} catch {
		return false;
	}
}

/** 判断父目录列表中是否隐藏 Pi/workspace 元数据；不是权限授予逻辑。 */
export function isProtectedWorkspacePath(relativePath: string): boolean {
	return relativePath.split("/").some((segment) => segment === ".git");
}

async function resolvePermissionPath(workspaceRoot: string, inputPath: string) {
	try {
		return await new FileResolver({ workspaceRoot, agentDir: workspaceRoot }).resolve(inputPath);
	} catch (error) {
		if (error instanceof FileResolveError) {
			return fail(error.code === "PATH_NOT_FOUND" ? "PATH_NOT_FOUND" : "INVALID_PATH", error.message, { path: inputPath });
		}
		if (isPermissionError(error)) return fail("PERMISSION_DENIED", "Path cannot be accessed.", { path: inputPath });
		throw error;
	}
}

function displayPath(workspaceRoot: string, resolved: { lexicalAbsolutePath: string; canonicalPath: string }): string {
	return maybeWorkspaceRelative(workspaceRoot, resolved.lexicalAbsolutePath, true) ?? maybeWorkspaceRelative(workspaceRoot, resolved.canonicalPath, true) ?? resolved.canonicalPath;
}

function isFailed<T>(result: T | FailedResult): result is FailedResult {
	return typeof result === "object" && result !== null && "status" in result && result.status === "failed";
}

function isPermissionError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
