import type { FsOperationContext, FsResult } from "../contracts/result.js";
import type { NativeFileSystem } from "../platform/node/native-filesystem.js";
import { createWorkspaceNamespace } from "./namespace.js";

export interface WriteAccessPreflightInput {
	readonly cwd: string;
	readonly path: string;
	readonly blockedPaths: readonly string[];
	readonly homeDirectory?: string;
	readonly native?: NativeFileSystem;
	readonly context?: FsOperationContext;
}

export interface WriteAccessPreflight {
	readonly displayPath: string;
	readonly workspacePath?: string;
}

/** Lightweight mandatory-policy check; it does not initialize config visibility or search services. */
export async function preflightWriteAccess(input: WriteAccessPreflightInput): Promise<FsResult<WriteAccessPreflight>> {
	const context = input.context ?? {};
	const namespace = await createWorkspaceNamespace({
		workspaceRoot: input.cwd,
		blockedPaths: input.blockedPaths,
		...(input.homeDirectory === undefined ? {} : { homeDirectory: input.homeDirectory }),
		...(input.native === undefined ? {} : { native: input.native }),
		context,
	});
	if (!namespace.ok) return namespace;
	const target = await namespace.value.paths.resolveTarget(input.path, { followExistingSymlink: true });
	if (!target.ok) return target;
	return {
		ok: true,
		value: {
			displayPath: target.value.displayPath,
			...(target.value.workspacePath === undefined ? {} : { workspacePath: target.value.workspacePath }),
		},
	};
}
