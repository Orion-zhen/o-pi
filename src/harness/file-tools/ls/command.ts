import type { FileToolLimits } from "../../file-tool-limits.ts";
import type { DirectoryEntry } from "../../filesystem/contracts/metadata.ts";
import type { DirectoryRef } from "../../filesystem/contracts/path.ts";
import type { FsOperationContext } from "../../filesystem/contracts/result.ts";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.ts";
import { mapFsError, type ToolOutcome } from "../shared/result.ts";
import type { LsEntry, LsEntryType, LsParams, LsSuccess } from "./types.ts";

const TYPE_RANK: Record<LsEntryType, number> = {
	directory: 0,
	file: 1,
	symlink: 2,
	other: 3,
};

export interface LsCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Readonly<Pick<FileToolLimits, "ls_entries">>;
}

/** Lists one directory without recursive traversal, content reads, or mutation. */
export async function listDirectory(
	params: LsParams,
	context: LsCommandContext,
): Promise<ToolOutcome<LsSuccess>> {
	const input = params.path ?? ".";
	const resolved = await context.filesystem.paths.resolveExisting(
		input,
		{ expected: "directory", followFinalSymlink: true },
	);
	if (!resolved.ok) return mapFsError(resolved.error);
	const listed = await context.filesystem.metadata.list(resolved.value);
	if (!listed.ok) return mapFsError(listed.error);

	const entries: LsEntry[] = [];
	for (const entry of listed.value) {
		const visibility = await context.filesystem.visibility.evaluate(entry.ref, "list-entry");
		if (!visibility.ok) return mapFsError(visibility.error);
		entries.push(toLsEntry(resolved.value, entry, visibility.value.ignored, visibility.value.source));
	}
	entries.sort(compareEntries);

	const visibleEntries = entries.slice(0, context.limits.ls_entries);
	if (visibleEntries.length < entries.length) {
		return {
			path: resolved.value.displayPath,
			entries: visibleEntries,
			truncated: true,
			returned_entries: visibleEntries.length,
			total_entries: entries.length,
			continuation_hint: truncationHint(entries, resolved.value.displayPath),
		};
	}
	return {
		path: resolved.value.displayPath,
		entries: visibleEntries,
		truncated: false,
	};
}

function truncationHint(entries: readonly LsEntry[], path: string): string {
	const directories = entries.filter((entry) => entry.type === "directory" && entry.ignored !== true).slice(0, 3).map((entry) => entry.path);
	const find = `find path=${JSON.stringify([path])} with a narrower query/glob`;
	return directories.length === 0 ? find : `ls one of ${JSON.stringify(directories)}, or ${find}`;
}

function toLsEntry(
	directory: DirectoryRef,
	entry: DirectoryEntry,
	ignored: boolean,
	ignoreSource: string | undefined,
): LsEntry {
	return {
		name: entry.name,
		path: childDisplayPath(directory.displayPath, entry.name),
		type: entry.ref.kind,
		...(entry.linkTarget === undefined ? {} : { link_target: entry.linkTarget }),
		...(ignored ? { ignored: true, ...(ignoreSource === undefined ? {} : { ignore_source: shortIgnoreSource(ignoreSource) }) } : {}),
	};
}

function childDisplayPath(parent: string, name: string): string {
	if (parent === ".") return name;
	const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
	return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

function compareEntries(left: LsEntry, right: LsEntry): number {
	const type = TYPE_RANK[left.type] - TYPE_RANK[right.type];
	if (type !== 0) return type;
	const folded = compareStableString(left.name.toLowerCase(), right.name.toLowerCase());
	return folded !== 0 ? folded : compareStableString(left.name, right.name);
}

function compareStableString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function shortIgnoreSource(source: string): string {
	const normalized = source.replaceAll("\\", "/");
	if (normalized.endsWith("/.git/info/exclude") || normalized === ".git/info/exclude") return ".git/info/exclude";
	if (normalized.endsWith("/.piignore") || normalized === ".piignore") return ".piignore";
	if (normalized.endsWith("/.gitignore") || normalized === ".gitignore") return ".gitignore";
	if (normalized.endsWith("/file-tools.jsonc") || normalized === "file-tools.jsonc" || normalized === "config") return "file-tools.jsonc";
	return source;
}
