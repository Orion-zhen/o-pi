import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { identityFromStat } from "./file-resolver.js";
import type { FileIdentity, PermissionResource, ResolvedFileResource } from "./permission-types.js";
import { identityEquals, isPathInside } from "./path-utils.js";

export interface HardProtectionContext {
	workspaceRoot: string;
	agentDir: string;
	homeDir: string;
}

/** 不可覆盖保护路径快照；canonicalPath 只在初始化时解析一次。 */
export interface ProtectedPath {
	id: string;
	reason: string;
	lexicalPath: string;
	canonicalPath?: string;
	missing?: {
		parentCanonicalPath: string;
		parentIdentity: FileIdentity;
		remainingSegments: string[];
	};
}

export interface HardProtectionResult {
	denied: boolean;
	reason?: string;
	ruleId?: string;
}

/** 初始化 hard protection 快照，避免检查时重新解释保护路径或跟随新 symlink。 */
export async function buildHardProtections(context: HardProtectionContext): Promise<ProtectedPath[]> {
	const protectedPaths: ProtectedPath[] = [];
	for (const spec of hardProtectedPathSpecs(context)) {
		protectedPaths.push(await protectPath(spec));
	}
	return protectedPaths;
}

/** 内建硬保护不可被 profile、策略、grant 或普通审批覆盖。 */
export function evaluateHardProtections(resources: PermissionResource[], protectedPaths: readonly ProtectedPath[]): HardProtectionResult {
	for (const resource of resources) {
		if (resource.kind !== "file") continue;
		for (const protectedPath of protectedPaths) {
			if (protectedPathMatches(protectedPath, resource)) {
				return { denied: true, reason: protectedPath.reason, ruleId: protectedPath.id };
			}
		}
	}
	return { denied: false };
}

function hardProtectedPathSpecs(context: HardProtectionContext): Array<{ id: string; lexicalPath: string; reason: string }> {
	const agentDir = path.resolve(context.agentDir);
	return [
		{ id: "credentials-ssh", lexicalPath: path.join(context.homeDir, ".ssh"), reason: "SSH credentials are protected." },
		{ id: "credentials-gnupg", lexicalPath: path.join(context.homeDir, ".gnupg"), reason: "GnuPG credentials are protected." },
		{ id: "pi-auth", lexicalPath: path.join(agentDir, "auth.json"), reason: "Pi authentication state is protected." },
		{ id: "pi-trust", lexicalPath: path.join(agentDir, "trust.json"), reason: "Pi trust state is protected." },
		{ id: "permission-config", lexicalPath: path.join(agentDir, "permissions.jsonc"), reason: "Permission policy must be edited through /permissions edit." },
		{ id: "permission-schema", lexicalPath: path.join(agentDir, "permissions.schema.json"), reason: "Permission schema is managed by the extension." },
		{ id: "permission-state", lexicalPath: path.join(agentDir, "permission-state"), reason: "Permission state and audit logs are protected." },
		{ id: "permission-code", lexicalPath: path.join(agentDir, "extensions", "permissions.ts"), reason: "Permission extension code is protected." },
	];
}

async function protectPath(spec: { id: string; lexicalPath: string; reason: string }): Promise<ProtectedPath> {
	try {
		return { ...spec, lexicalPath: path.resolve(spec.lexicalPath), canonicalPath: await realpath(spec.lexicalPath) };
	} catch (error) {
		const missing = await missingProtection(spec.lexicalPath).catch(() => undefined);
		return missing === undefined ? { ...spec, lexicalPath: path.resolve(spec.lexicalPath) } : { ...spec, lexicalPath: path.resolve(spec.lexicalPath), missing };
	}
}

async function missingProtection(lexicalPath: string): Promise<ProtectedPath["missing"]> {
	const parent = await nearestExistingCanonicalParent(path.resolve(lexicalPath));
	const parentInfo = await stat(parent.canonicalPath);
	return {
		parentCanonicalPath: parent.canonicalPath,
		parentIdentity: identityFromStat(parentInfo),
		remainingSegments: parent.remainingSegments,
	};
}

async function nearestExistingCanonicalParent(absolutePath: string): Promise<{ canonicalPath: string; remainingSegments: string[] }> {
	const remainingSegments: string[] = [];
	let current = path.resolve(absolutePath);
	for (;;) {
		try {
			await lstat(current);
			const canonicalPath = await realpath(current);
			const info = await stat(canonicalPath);
			if (info.isDirectory()) return { canonicalPath, remainingSegments };
		} catch (error) {
			if (!isPathLookupFailure(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`No canonical parent for protected path: ${absolutePath}`);
		remainingSegments.unshift(path.basename(current));
		current = parent;
	}
}

function protectedPathMatches(protectedPath: ProtectedPath, resource: ResolvedFileResource): boolean {
	const protectedCandidates = [protectedPath.lexicalPath, protectedPath.canonicalPath].filter((item): item is string => item !== undefined);
	const resourceCandidates = [resource.lexicalAbsolutePath, resource.canonicalPath, ...resource.symlinkChain];
	if (protectedCandidates.some((protectedCandidate) => resourceCandidates.some((resourceCandidate) => isPathInside(protectedCandidate, resourceCandidate)))) {
		return true;
	}
	return protectedPath.missing !== undefined && missingProtectedPathMatches(protectedPath.missing, resource);
}

function missingProtectedPathMatches(missing: NonNullable<ProtectedPath["missing"]>, resource: ResolvedFileResource): boolean {
	const expectedPath = path.join(missing.parentCanonicalPath, ...missing.remainingSegments);
	if (isPathInside(expectedPath, resource.lexicalAbsolutePath) || isPathInside(expectedPath, resource.canonicalPath)) return true;
	if (resource.canonicalParentIdentity === undefined || resource.canonicalParentPath === undefined) return false;
	return identityEquals(missing.parentIdentity, resource.canonicalParentIdentity) && isPathInside(expectedPath, resource.canonicalPath);
}

function isPathLookupFailure(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP");
}
