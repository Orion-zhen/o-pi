import { pathMatchesAnyRule, pathMatchesRule, resolveNativeInputPath, type PathIdentity } from "../filesystem/kernel/access-policy.js";
import { createWorkspaceNamespace } from "../filesystem/kernel/namespace.js";

export interface PathGuardConfig {
	cwd: string;
	blocked_path: string[];
}

export interface GuardedPath {
	input_path: string;
	abs_path: string;
	real_path?: string;
}

export interface PathGuardBlock {
	code: "BLOCKED_PATH";
	message: string;
	input_path: string;
	matched_path?: string;
	matched_rule?: string;
}

export type { PathIdentity };
export { pathMatchesAnyRule, pathMatchesRule };

export class PathGuardBlockedError extends Error {
	constructor(readonly block: PathGuardBlock) {
		super(block.message);
		this.name = "PathGuardBlockedError";
	}
}

/** Transitional raw-path adapter for tools not yet vertically migrated to opaque refs. */
export async function guardExistingPath(inputPath: string, config: PathGuardConfig): Promise<GuardedPath> {
	return guardPath(inputPath, config, false);
}

/** Raw-path preflight only; callers still recheck inside their mutation queue. */
export async function guardWritablePath(inputPath: string, config: PathGuardConfig): Promise<GuardedPath> {
	return guardPath(inputPath, config, true);
}

async function guardPath(inputPath: string, config: PathGuardConfig, writable: boolean): Promise<GuardedPath> {
	const absolutePath = resolveNativeInputPath(config.cwd, inputPath);
	const namespace = await createWorkspaceNamespace({ workspaceRoot: config.cwd, blockedPaths: config.blocked_path });
	if (!namespace.ok) return handleFailure(inputPath, absolutePath, namespace.error, writable);
	const target = await namespace.value.paths.resolveTarget(inputPath, { followExistingSymlink: true }, {});
	if (!target.ok) return handleFailure(inputPath, absolutePath, target.error, writable);
	const identity = namespace.value.bridge.getNativeIdentity(target.value);
	return {
		input_path: inputPath,
		abs_path: identity?.lexicalPath ?? absolutePath,
		...(target.value.existingKind === undefined || identity === undefined ? {} : { real_path: identity.canonicalPath }),
	};
}

function handleFailure(
	inputPath: string,
	absolutePath: string,
	error: { readonly code: string; readonly message: string; readonly details?: Readonly<Record<string, unknown>> },
	writable: boolean,
): GuardedPath {
	if (error.code === "blocked") {
		throw new PathGuardBlockedError({
			code: "BLOCKED_PATH",
			message: "Path is blocked by file-tools config.",
			input_path: inputPath,
			...(typeof error.details?.["matchedPath"] === "string" ? { matched_path: error.details["matchedPath"] } : {}),
			...(typeof error.details?.["matchedRule"] === "string" ? { matched_rule: error.details["matchedRule"] } : {}),
		});
	}
	if (!writable && error.code === "not-found") return { input_path: inputPath, abs_path: absolutePath };
	throw new PathGuardNativeError(
		error.message,
		error.code === "access-denied" ? "EACCES" : error.code === "not-directory" ? "ENOTDIR" : "EINVAL",
	);
}

class PathGuardNativeError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "PathGuardNativeError";
	}
}
