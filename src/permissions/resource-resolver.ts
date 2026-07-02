import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { classifyBoundary } from "./boundary-classifier.js";
import type { FileIdentity, PermissionTargetType, ResolvedPermissionPath } from "./permission-types.js";
import { maybeWorkspaceRelative, normalizeUserPath, validatePathText } from "./path-utils.js";

export interface ResourceResolverOptions {
	workspaceRoot: string;
	agentDir?: string;
	extraSensitivePaths?: string[];
}

/** 将用户路径解析为授权可判断的 canonical 资源。 */
export class ResourceResolver {
	constructor(private readonly options: ResourceResolverOptions) {}

	async resolve(inputPath: string): Promise<ResolvedPermissionPath> {
		const invalid = validatePathText(inputPath);
		if (invalid !== undefined) throw new ResourceResolveError("INVALID_PATH", invalid, inputPath);

		const absolutePath = normalizeUserPath(this.options.workspaceRoot, inputPath);
		let lst;
		try {
			lst = await lstat(absolutePath);
		} catch (error) {
			if (isNotFound(error)) return await this.resolveMissing(inputPath, absolutePath);
			throw error;
		}

		const canonicalPath = await realpath(absolutePath);
		const type = targetType(lst);
		const canonicalStat = await stat(canonicalPath);
		const identity = identityFromStat(canonicalStat);
		const workspaceRelativePath = maybeWorkspaceRelative(this.options.workspaceRoot, canonicalPath, true);
		const boundary = classifyBoundary(canonicalPath, this.options);

		return {
			inputPath,
			absolutePath,
			canonicalPath,
			...(workspaceRelativePath !== undefined ? { workspaceRelativePath } : {}),
			boundary,
			exists: true,
			type,
			viaSymlink: path.resolve(absolutePath) !== path.resolve(canonicalPath),
			symlinkChain: path.resolve(absolutePath) !== path.resolve(canonicalPath) ? [absolutePath, canonicalPath] : [],
			identity,
		};
	}

	private async resolveMissing(inputPath: string, absolutePath: string): Promise<ResolvedPermissionPath> {
		const parent = await nearestExistingParent(absolutePath);
		const parentRealPath = await realpath(parent.existingPath);
		const parentStat = await stat(parentRealPath);
		if (!parentStat.isDirectory()) {
			throw new ResourceResolveError("INVALID_PATH", "Nearest existing parent is not a directory.", inputPath);
		}
		const canonicalPath = path.join(parentRealPath, ...parent.missingSegments);
		const workspaceRelativePath = maybeWorkspaceRelative(this.options.workspaceRoot, canonicalPath, false);
		const boundary = classifyBoundary(canonicalPath, this.options);
		return {
			inputPath,
			absolutePath,
			canonicalPath,
			...(workspaceRelativePath !== undefined ? { workspaceRelativePath } : {}),
			boundary,
			exists: false,
			type: "missing",
			viaSymlink: path.resolve(path.dirname(absolutePath)) !== path.resolve(path.dirname(canonicalPath)),
			symlinkChain: path.resolve(path.dirname(absolutePath)) !== path.resolve(path.dirname(canonicalPath)) ? [path.dirname(absolutePath), path.dirname(canonicalPath)] : [],
			canonicalParentPath: parentRealPath,
			canonicalParentIdentity: identityFromStat(parentStat),
		};
	}
}

export class ResourceResolveError extends Error {
	constructor(
		readonly code: "INVALID_PATH" | "PATH_NOT_FOUND",
		message: string,
		readonly inputPath: string,
	) {
		super(message);
	}
}

export function identityFromStat(info: { dev?: number; ino?: number }): FileIdentity {
	const identity: FileIdentity = {};
	if (typeof info.dev === "number") identity.device = info.dev;
	if (typeof info.ino === "number") identity.inode = info.ino;
	return identity;
}

async function nearestExistingParent(absolutePath: string): Promise<{ existingPath: string; missingSegments: string[] }> {
	const missingSegments: string[] = [];
	let current = path.resolve(absolutePath);
	for (;;) {
		const parent = path.dirname(current);
		const base = path.basename(current);
		try {
			await lstat(current);
			return { existingPath: current, missingSegments };
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		if (parent === current) {
			throw new ResourceResolveError("PATH_NOT_FOUND", "No existing parent directory found.", absolutePath);
		}
		missingSegments.unshift(base);
		current = parent;
	}
}

function targetType(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): PermissionTargetType {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isFile()) return "file";
	if (info.isDirectory()) return "directory";
	return "other";
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
