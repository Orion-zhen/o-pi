import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.js";
import type { FailedResult, ResolvedPath, TargetPath, ToolOutcome } from "./types.js";

const PROTECTED_SEGMENTS = new Set([".git"]);

/** workspace root 的真实路径；所有用户路径最终都必须落在这里面。 */
export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
	return await realpath(cwd);
}

/** 校验并解析已存在的普通文件路径。 */
export async function resolveExistingFile(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<ResolvedPath>> {
	const base = validateRelativePath(inputPath);
	if (base) return base;

	const absolutePath = path.resolve(workspaceRoot, inputPath);
	const relativePath = toWorkspaceRelative(workspaceRoot, absolutePath);
	if (!relativePath) {
		return fail("PATH_OUTSIDE_WORKSPACE", "Path is outside the workspace.", { path: inputPath });
	}
	if (isProtected(relativePath)) {
		return fail("PROTECTED_PATH", "Protected workspace metadata cannot be accessed.", { path: relativePath });
	}

	let realTarget: string;
	try {
		realTarget = await realpath(absolutePath);
	} catch {
		return fail("FILE_NOT_FOUND", "File does not exist.", { path: relativePath });
	}

	if (!isInside(workspaceRoot, realTarget)) {
		return fail("SYMLINK_OUTSIDE_WORKSPACE", "Path resolves outside the workspace.", { path: relativePath });
	}

	const fileStat = await stat(realTarget);
	if (!fileStat.isFile()) {
		return fail("FILE_NOT_FOUND", "Path is not a regular file.", { path: relativePath });
	}

	return { inputPath, relativePath, absolutePath, realPath: realTarget };
}

/** 校验并解析可创建或替换的目标路径；父目录必须已存在且不能逃逸 workspace。 */
export async function resolveTargetFile(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<TargetPath>> {
	const base = validateRelativePath(inputPath);
	if (base) return base;

	const absolutePath = path.resolve(workspaceRoot, inputPath);
	const relativePath = toWorkspaceRelative(workspaceRoot, absolutePath);
	if (!relativePath) {
		return fail("PATH_OUTSIDE_WORKSPACE", "Path is outside the workspace.", { path: inputPath });
	}
	if (isProtected(relativePath)) {
		return fail("PROTECTED_PATH", "Protected workspace metadata cannot be modified.", { path: relativePath });
	}

	const parent = path.dirname(absolutePath);
	let parentRealPath: string;
	try {
		parentRealPath = await realpath(parent);
	} catch {
		return fail("FILE_NOT_FOUND", "Parent directory does not exist.", { path: relativePath });
	}

	if (!isInside(workspaceRoot, parentRealPath)) {
		return fail("SYMLINK_OUTSIDE_WORKSPACE", "Parent directory resolves outside the workspace.", { path: relativePath });
	}

	const parentStat = await stat(parentRealPath);
	if (!parentStat.isDirectory()) {
		return fail("INVALID_PATH", "Parent path is not a directory.", { path: relativePath });
	}

	return { inputPath, relativePath, absolutePath, parentRealPath };
}

export async function fileExists(absolutePath: string): Promise<boolean> {
	try {
		const result = await lstat(absolutePath);
		return result.isFile() || result.isSymbolicLink();
	} catch {
		return false;
	}
}

function validateRelativePath(inputPath: string): FailedResult | undefined {
	if (typeof inputPath !== "string" || inputPath.trim() === "" || inputPath.includes("\0")) {
		return fail("INVALID_PATH", "Path must be a non-empty relative path.", { path: inputPath });
	}
	if (path.isAbsolute(inputPath)) {
		return fail("PATH_OUTSIDE_WORKSPACE", "Absolute paths are not allowed.", { path: inputPath });
	}
	const normalized = path.normalize(inputPath);
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
		return fail("PATH_OUTSIDE_WORKSPACE", "Parent-directory traversal is not allowed.", { path: inputPath });
	}
	return undefined;
}

function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string | undefined {
	if (!isInside(workspaceRoot, absolutePath)) return undefined;
	const relative = path.relative(workspaceRoot, absolutePath);
	return relative === "" ? undefined : relative.split(path.sep).join("/");
}

function isInside(workspaceRoot: string, candidate: string): boolean {
	const relative = path.relative(workspaceRoot, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isProtected(relativePath: string): boolean {
	return relativePath.split("/").some((segment) => PROTECTED_SEGMENTS.has(segment));
}
