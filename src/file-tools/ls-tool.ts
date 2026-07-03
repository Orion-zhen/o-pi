import { readdir } from "node:fs/promises";
import { fail, isFailed } from "./errors.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import {
	defaultPermissionService,
	defaultPromptContext,
	permissionFailure,
	type FileToolPermissionRuntime,
} from "./permission-runtime.js";
import { isProtectedWorkspacePath, resolveExistingDirectory, resolveWorkspaceRoot } from "./path-security.js";
import type { LsEntry, LsEntryType, LsParams, LsSuccess, ToolOutcome } from "./types.js";

const MAX_LS_ENTRIES = 200;

const TYPE_RANK: Record<LsEntryType, number> = {
	directory: 0,
	file: 1,
	symlink: 2,
	other: 3,
};

/** ls 只列出目录直属成员；不递归、不读取文件内容、不修改 workspace。 */
export async function listWorkspaceDirectory(
	cwd: string,
	params: LsParams,
	runtime: FileToolPermissionRuntime = {},
): Promise<ToolOutcome<LsSuccess>> {
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const permissionService = runtime.permissionService ?? defaultPermissionService(workspaceRoot);
	const authorization = await permissionService.authorizeSubjectCall({
		kind: "tool",
		configKey: "ls",
		input: params,
		executionId: runtime.toolCallId ?? "direct-ls",
		promptContext: runtime.promptContext ?? defaultPromptContext(),
		consumeLease: true,
	});
	if (!authorization.allowed) return permissionFailure({ code: authorization.error.code, message: authorization.error.message, resources: [] });
	if (!(await permissionService.verifySubjectRequestUnchanged(authorization.request, { kind: "tool", configKey: "ls", input: params }))) {
		return fail("PERMISSION_CONTEXT_CHANGED", "Permission context changed before listing.", { path: params.path });
	}
	const resolved = await resolveExistingDirectory(workspaceRoot, params.path);
	if (isFailed(resolved)) return resolved;
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot);

	let rawEntries;
	try {
		rawEntries = await readdir(resolved.realPath, { withFileTypes: true });
	} catch (error) {
		if (isPermissionError(error)) {
			return fail("PERMISSION_DENIED", "Directory cannot be listed.", { path: resolved.relativePath });
		}
		return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: resolved.relativePath });
	}

	const entries: LsEntry[] = [];
	let blockedEntries = 0;
	for (const entry of rawEntries) {
		const entryPath = childRelativePath(resolved.relativePath, entry.name);
		const workspaceEntry = isWorkspaceRelative(entryPath);
		if (workspaceEntry && isProtectedWorkspacePath(entryPath)) {
			blockedEntries += 1;
			continue;
		}
		const type = entryType(entry);
		const ignoreDecision = workspaceEntry
			? ignoreSnapshot.evaluate({ path: entryPath, kind: type, intent: "list-entry" })
			: { ignored: false, matchedRule: undefined };
		const lsEntry: LsEntry = {
			name: entry.name,
			path: entryPath,
			type,
		};
		if (ignoreDecision.ignored) {
			lsEntry.ignored = true;
			if (ignoreDecision.matchedRule !== undefined) lsEntry.ignore_source = shortIgnoreSource(ignoreDecision.matchedRule.sourceType);
		}
		entries.push(lsEntry);
	}

	entries.sort(compareEntries);

	const visibleEntries = entries.slice(0, MAX_LS_ENTRIES);
	const truncated = visibleEntries.length < entries.length;
	return {
		path: resolved.relativePath,
		entries: visibleEntries,
		truncated,
		...(truncated
			? {
					returned_entries: visibleEntries.length,
					total_entries: entries.length,
					continuation_hint: "List a more specific subdirectory.",
				}
			: {}),
		...(blockedEntries > 0 ? { blocked_entries: blockedEntries } : {}),
	};
}

function childRelativePath(parent: string, name: string): string {
	return parent === "." ? name : `${parent}/${name}`;
}

function isWorkspaceRelative(value: string): boolean {
	return value === "." || (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value));
}

function entryType(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): LsEntryType {
	if (entry.isSymbolicLink()) return "symlink";
	if (entry.isDirectory()) return "directory";
	if (entry.isFile()) return "file";
	return "other";
}

function compareEntries(left: LsEntry, right: LsEntry): number {
	const type = TYPE_RANK[left.type] - TYPE_RANK[right.type];
	if (type !== 0) return type;

	const leftFolded = left.name.toLowerCase();
	const rightFolded = right.name.toLowerCase();
	const folded = compareStableString(leftFolded, rightFolded);
	if (folded !== 0) return folded;
	return compareStableString(left.name, right.name);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function shortIgnoreSource(sourceType: string): string {
	if (sourceType === "piignore") return ".piignore";
	if (sourceType === "gitignore") return ".gitignore";
	if (sourceType === "git-info-exclude") return ".git/info/exclude";
	return sourceType;
}

function isPermissionError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
