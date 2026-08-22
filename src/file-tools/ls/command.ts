import type { DirectoryEntry } from "../../filesystem/contracts/metadata.js";
import type { DirectoryRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { mapFsError, type ToolOutcome } from "../shared/result.js";
import type { LsEntry, LsEntryType, LsParams, LsSuccess } from "./types.js";

const TYPE_RANK: Record<LsEntryType, number> = {
	directory: 0,
	file: 1,
	symlink: 2,
	other: 3,
};

export interface LsCommandContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly entryLimit: number;
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

	const visibleEntries = entries.slice(0, context.entryLimit);
	const truncated = visibleEntries.length < entries.length;
	return {
		path: resolved.value.displayPath,
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
