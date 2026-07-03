import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isBlockedPath, toolPathIdentity, type FileToolsConfig } from "./config.js";
import { fail } from "./errors.js";
import type { FailedResult, ResolvedPath, TargetPath, ToolOutcome } from "./types.js";

/** 返回工具相对路径的解析基准；它不是访问边界。 */
export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
	return await realpath(cwd);
}

/** 解析已存在目录；接受 Pi 进程可访问的相对或绝对路径。 */
export async function resolveExistingDirectory(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig,
): Promise<ToolOutcome<ResolvedPath>> {
	const resolved = await resolveExistingPath(workspaceRoot, inputPath, "PATH_NOT_FOUND", config);
	if (isFailed(resolved)) return resolved;
	const info = await stat(resolved.realPath);
	if (!info.isDirectory()) return fail("NOT_A_DIRECTORY", "Path is not a directory.", { path: resolved.relativePath });
	return resolved;
}

/** 解析已存在普通文件；接受 Pi 进程可访问的相对或绝对路径。 */
export async function resolveExistingFile(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig,
): Promise<ToolOutcome<ResolvedPath>> {
	const resolved = await resolveExistingPath(workspaceRoot, inputPath, "FILE_NOT_FOUND", config);
	if (isFailed(resolved)) return resolved;
	const info = await stat(resolved.realPath);
	if (!info.isFile()) return fail("NOT_A_FILE", "Path is not a regular file.", { path: resolved.relativePath });
	return resolved;
}

/** 解析可创建或替换的目标文件；不存在目标时只要求最近存在父路径是目录。 */
export async function resolveTargetFile(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig,
): Promise<ToolOutcome<TargetPath>> {
	const lexical = normalizeToolPath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	if (lexical.relativePath === ".") return fail("INVALID_PATH", "Target must be a file path, not the current directory.", { path: inputPath });
	if (isBlockedPath(config, toolPathIdentity(lexical.relativePath, lexical.absolutePath, lexical.workspacePath))) {
		return fail("PROTECTED_PATH", "Path is blocked by file-tools config.", { path: lexical.relativePath });
	}

	const parent = await resolveExistingParent(workspaceRoot, lexical.absolutePath, path.isAbsolute(inputPath));
	if (isFailed(parent)) return parent;
	const parentInfo = await stat(parent.parentRealPath);
	if (!parentInfo.isDirectory()) return fail("INVALID_PATH", "Parent path is not a directory.", { path: lexical.relativePath });

	return {
		inputPath,
		relativePath: lexical.relativePath,
		absolutePath: lexical.absolutePath,
		...(lexical.workspacePath !== undefined ? { workspacePath: lexical.workspacePath } : {}),
		parentRealPath: parent.parentRealPath,
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

/** ignore 规则发现仍跳过 Git 元数据目录，避免扫描仓库内部状态。 */
export function isWorkspaceMetadataPath(relativePath: string): boolean {
	return relativePath.split(/[\\/]+/).some((segment) => segment === ".git");
}

async function resolveExistingPath(
	workspaceRoot: string,
	inputPath: string,
	missingCode: "FILE_NOT_FOUND" | "PATH_NOT_FOUND",
	config: FileToolsConfig,
): Promise<ToolOutcome<ResolvedPath>> {
	const lexical = normalizeToolPath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	if (isBlockedPath(config, toolPathIdentity(lexical.relativePath, lexical.absolutePath, lexical.workspacePath))) {
		return fail("PROTECTED_PATH", "Path is blocked by file-tools config.", { path: lexical.relativePath });
	}
	let real: string;
	try {
		real = await realpath(lexical.absolutePath);
	} catch (error) {
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Path cannot be accessed.", { path: lexical.relativePath });
		return fail(missingCode, missingCode === "FILE_NOT_FOUND" ? "File does not exist." : "Directory does not exist.", {
			path: lexical.relativePath,
		});
	}
	return {
		inputPath,
		relativePath: lexical.relativePath,
		absolutePath: lexical.absolutePath,
		realPath: real,
		...(lexical.workspacePath !== undefined ? { workspacePath: lexical.workspacePath } : {}),
	};
}

function normalizeToolPath(workspaceRoot: string, inputPath: string): ToolOutcome<{ absolutePath: string; relativePath: string; workspacePath?: string }> {
	if (inputPath.length === 0) return fail("INVALID_PATH", "Path must not be empty.", { path: inputPath });
	if (inputPath.includes("\0")) return fail("INVALID_PATH", "Path must not contain NUL bytes.", { path: inputPath });

	const absolutePath = path.resolve(workspaceRoot, inputPath);
	const workspacePath = workspaceRelative(workspaceRoot, absolutePath);
	return {
		absolutePath,
		relativePath: path.isAbsolute(inputPath) ? path.normalize(absolutePath) : (workspacePath ?? normalizeRelative(path.relative(workspaceRoot, absolutePath))),
		...(workspacePath !== undefined ? { workspacePath } : {}),
	};
}

async function resolveExistingParent(
	workspaceRoot: string,
	absolutePath: string,
	inputWasAbsolute: boolean,
): Promise<ToolOutcome<{ parentRealPath: string }>> {
	let current = path.dirname(absolutePath);
	while (true) {
		const displayPath = inputWasAbsolute ? path.normalize(current) : (workspaceRelative(workspaceRoot, current) ?? normalizeRelative(path.relative(workspaceRoot, current)));
		try {
			const info = await lstat(current);
			if (!info.isDirectory() && !info.isSymbolicLink()) return fail("INVALID_PATH", "Parent path is not a directory.", { path: displayPath });
			const parentRealPath = await realpath(current);
			return { parentRealPath };
		} catch (error) {
			if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Parent path cannot be accessed.", { path: displayPath });
			const next = path.dirname(current);
			if (next === current) return fail("PATH_NOT_FOUND", "Parent directory does not exist.");
			current = next;
		}
	}
}

function workspaceRelative(workspaceRoot: string, candidate: string): string | undefined {
	const relative = path.relative(workspaceRoot, candidate);
	if (relative === "") return ".";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.replace(/\\/g, "/");
}

function normalizeRelative(value: string): string {
	return value === "" ? "." : value.replace(/\\/g, "/");
}

function isFailed<T>(result: T | FailedResult): result is FailedResult {
	return typeof result === "object" && result !== null && "status" in result && result.status === "failed";
}

function isAccessDenied(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
