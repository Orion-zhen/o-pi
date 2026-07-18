import { readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { ignoreConfigFromFileTools, isBlockedPath, isIgnoredPath, loadFileToolsConfig, type ToolPathIdentity } from "../config.js";
import { fail, isAccessDenied, isFailed } from "../core/errors.js";
import { defaultIgnoreEngine } from "../ignore/ignore-engine.js";
import { resolveExistingDirectory, resolveWorkspaceRoot } from "../core/path-resolver.js";
import type { LsEntry, LsEntryType, LsParams, LsSuccess, ToolOutcome } from "../types.js";

const TYPE_RANK: Record<LsEntryType, number> = {
	directory: 0,
	file: 1,
	symlink: 2,
	other: 3,
};

/** ls 只列出目录直属成员；不递归、不读取文件内容、不修改 workspace。 */
export async function listWorkspaceDirectory(cwd: string, params: LsParams): Promise<ToolOutcome<LsSuccess>> {
	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const resolved = await resolveExistingDirectory(workspaceRoot, params.path ?? ".", config);
	if (isFailed(resolved)) return resolved;
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));

	let rawEntries;
	try {
		rawEntries = await readdir(resolved.realPath, { withFileTypes: true });
	} catch (error) {
		if (isAccessDenied(error)) {
			return fail("ACCESS_DENIED", "Directory cannot be listed.", { path: resolved.relativePath });
		}
		return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: resolved.relativePath });
	}

	const entries: LsEntry[] = [];
	for (const entry of rawEntries) {
		const entryPath = childPath(resolved.relativePath, entry.name);
		const identity = childIdentity(resolved, entryPath, entry.name);
		if (isBlockedPath(config, identity)) continue;
		const workspaceEntryPath = childWorkspacePath(resolved.workspacePath, entry.name);
		const type = entryType(entry);
		const ignoreDecision = workspaceEntryPath !== undefined
			? ignoreSnapshot.evaluate({ path: workspaceEntryPath, kind: type, intent: "list-entry" })
			: { ignored: false, matchedRule: undefined };
		const lsEntry: LsEntry = {
			name: entry.name,
			path: entryPath,
			type,
		};
		if (type === "symlink") {
			const target = await readSymlinkTarget(path.join(resolved.realPath, entry.name));
			if (target !== undefined) lsEntry.link_target = target;
		}
		if (isIgnoredPath(config, identity)) {
			lsEntry.ignored = true;
			lsEntry.ignore_source = "file-tools.jsonc";
		} else if (ignoreDecision.ignored) {
			lsEntry.ignored = true;
			if (ignoreDecision.matchedRule !== undefined) lsEntry.ignore_source = shortIgnoreSource(ignoreDecision.matchedRule.sourceType);
		}
		entries.push(lsEntry);
	}

	entries.sort(compareEntries);

	const visibleEntries = entries.slice(0, config.limits.ls_entries);
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
	};
}

/** 将 ls 成功结果渲染成模型可见的 shell 风格文本；完整结构保留在工具 details。 */
export function formatCompactLsResult(result: LsSuccess): string {
	const header = result.truncated
		? `${result.path} ${result.returned_entries ?? result.entries.length}/${result.total_entries ?? result.entries.length} truncated`
		: `${result.path} ${result.entries.length}`;
	const lines = [header, ...result.entries.map(formatCompactEntry)];
	if (result.truncated) lines.push("[narrow path]");
	return lines.join("\n");
}

function childPath(parent: string, name: string): string {
	if (parent === ".") return name;
	return normalizePath(path.join(parent, name));
}

function childWorkspacePath(parent: string | undefined, name: string): string | undefined {
	if (parent === undefined) return undefined;
	return parent === "." ? name : `${parent}/${name}`;
}

function childIdentity(
	parent: { absolutePath: string; workspacePath?: string },
	displayPath: string,
	name: string,
): ToolPathIdentity {
	const absolutePath = path.join(parent.absolutePath, name);
	const workspacePath = childWorkspacePath(parent.workspacePath, name);
	return {
		displayPath,
		absolutePath,
		...(workspacePath !== undefined ? { workspacePath } : {}),
	};
}

function normalizePath(value: string): string {
	return path.isAbsolute(value) ? path.normalize(value) : value.replace(/\\/g, "/");
}

function entryType(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): LsEntryType {
	if (entry.isSymbolicLink()) return "symlink";
	if (entry.isDirectory()) return "directory";
	if (entry.isFile()) return "file";
	return "other";
}

function formatCompactEntry(entry: LsEntry): string {
	const name = escapeLineText(entry.name);
	const ignored = entry.ignored === true ? ` !${entry.ignore_source ?? "ignored"}` : "";
	if (entry.type === "directory") return `${name}/${ignored}`;
	if (entry.type === "symlink") {
		const target = entry.link_target === undefined ? "" : ` -> ${escapeLineText(entry.link_target)}`;
		return `${name}@${target}${ignored}`;
	}
	if (entry.type === "other") return `${name}?${ignored}`;
	return `${name}${ignored}`;
}

function escapeLineText(value: string): string {
	return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
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

async function readSymlinkTarget(absolutePath: string): Promise<string | undefined> {
	try {
		return await readlink(absolutePath);
	} catch {
		return undefined;
	}
}
