import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { fileResourceUri } from "../model/resources.js";
import type { ActionId, AuthorizationAtom, JsonValue } from "../model/types.js";
import { maybeWorkspaceRelative, normalizeUserPath, validatePathText, type FileIdentity } from "./path-utils.js";

type FileNodeType = "file" | "directory" | "symlink" | "other";

export interface ResolvedFileEvidence {
	inputPath: string;
	lexicalAbsolutePath: string;
	canonicalPath: string;
	resource: string;
	lexicalType: FileNodeType;
	targetType: Exclude<FileNodeType, "symlink">;
	exists: boolean;
	viaSymlink: boolean;
	symlinkChain: readonly string[];
	identity?: FileIdentity;
	canonicalParentPath?: string;
	canonicalParentIdentity?: FileIdentity;
	displayPath: string;
}

export class FileResolveError extends Error {
	constructor(
		readonly code: "INVALID_PATH" | "PATH_NOT_FOUND",
		message: string,
		readonly inputPath: string,
	) {
		super(message);
	}
}

/** 路径解析输出统一 file:// resource，并把目标或父目录 identity 纳入 atom evidence。 */
export class FileResolver {
	constructor(private readonly options: { workspaceRoot: string; agentDir: string }) {}

	async atom(inputPath: string, action: ActionId): Promise<AuthorizationAtom> {
		const evidence = await this.resolve(inputPath);
		return {
			action,
			resource: evidence.resource,
			attributes: evidenceAttributes(evidence),
		};
	}

	async resolve(inputPath: string): Promise<ResolvedFileEvidence> {
		const invalid = validatePathText(inputPath);
		if (invalid !== undefined) throw new FileResolveError("INVALID_PATH", invalid, inputPath);
		const lexicalAbsolutePath = normalizeUserPath(this.options.workspaceRoot, inputPath, this.options.agentDir);
		let lexicalStat;
		try {
			lexicalStat = await lstat(lexicalAbsolutePath);
		} catch (error) {
			if (isNotFound(error)) return await this.resolveMissing(inputPath, lexicalAbsolutePath);
			throw error;
		}
		const canonicalPath = await realpath(lexicalAbsolutePath);
		const targetStat = await stat(canonicalPath);
		const lexicalType = nodeType(lexicalStat);
		const targetType = targetNodeType(targetStat);
		const viaSymlink = path.resolve(lexicalAbsolutePath) !== path.resolve(canonicalPath) || lexicalType === "symlink";
		return {
			inputPath,
			lexicalAbsolutePath,
			canonicalPath,
			resource: fileResourceUri(canonicalPath),
			lexicalType,
			targetType,
			exists: true,
			viaSymlink,
			symlinkChain: viaSymlink ? [lexicalAbsolutePath, canonicalPath] : [],
			identity: identityFromStat(targetStat),
			displayPath: maybeWorkspaceRelative(this.options.workspaceRoot, canonicalPath, true) ?? canonicalPath,
		};
	}

	private async resolveMissing(inputPath: string, lexicalAbsolutePath: string): Promise<ResolvedFileEvidence> {
		const parent = await nearestExistingParent(lexicalAbsolutePath, inputPath);
		const parentCanonical = await realpath(parent.existingPath);
		const parentStat = await stat(parentCanonical);
		if (!parentStat.isDirectory()) throw new FileResolveError("INVALID_PATH", "Nearest existing parent is not a directory.", inputPath);
		const canonicalPath = path.join(parentCanonical, ...parent.missingSegments);
		const viaSymlink = path.resolve(path.dirname(lexicalAbsolutePath)) !== path.resolve(path.dirname(canonicalPath));
		return {
			inputPath,
			lexicalAbsolutePath,
			canonicalPath,
			resource: fileResourceUri(canonicalPath),
			lexicalType: "other",
			targetType: "other",
			exists: false,
			viaSymlink,
			symlinkChain: viaSymlink ? [path.dirname(lexicalAbsolutePath), path.dirname(canonicalPath)] : [],
			canonicalParentPath: parentCanonical,
			canonicalParentIdentity: identityFromStat(parentStat),
			displayPath: maybeWorkspaceRelative(this.options.workspaceRoot, canonicalPath, false) ?? canonicalPath,
		};
	}
}

export function evidenceAttributes(evidence: ResolvedFileEvidence): Readonly<Record<string, JsonValue>> {
	return {
		inputPath: evidence.inputPath,
		lexicalAbsolutePath: evidence.lexicalAbsolutePath,
		canonicalPath: evidence.canonicalPath,
		lexicalType: evidence.lexicalType,
		targetType: evidence.targetType,
		exists: evidence.exists,
		viaSymlink: evidence.viaSymlink,
		symlinkChain: evidence.symlinkChain,
		device: evidence.identity?.device ?? evidence.canonicalParentIdentity?.device ?? null,
		inode: evidence.identity?.inode ?? evidence.canonicalParentIdentity?.inode ?? null,
		parentCanonicalPath: evidence.canonicalParentPath ?? null,
		displayPath: evidence.displayPath,
	};
}

export function identityFromStat(info: { dev?: number; ino?: number }): FileIdentity {
	const identity: FileIdentity = {};
	if (typeof info.dev === "number") identity.device = info.dev;
	if (typeof info.ino === "number") identity.inode = info.ino;
	return identity;
}

async function nearestExistingParent(absolutePath: string, inputPath: string): Promise<{ existingPath: string; missingSegments: string[] }> {
	const missingSegments: string[] = [];
	let current = path.resolve(absolutePath);
	for (;;) {
		try {
			await lstat(current);
			return { existingPath: current, missingSegments };
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new FileResolveError("PATH_NOT_FOUND", "No existing parent directory found.", inputPath);
		missingSegments.unshift(path.basename(current));
		current = parent;
	}
}

function nodeType(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileNodeType {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "directory";
	if (info.isFile()) return "file";
	return "other";
}

function targetNodeType(info: { isFile(): boolean; isDirectory(): boolean }): Exclude<FileNodeType, "symlink"> {
	if (info.isDirectory()) return "directory";
	if (info.isFile()) return "file";
	return "other";
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
