import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { createVisibilitySnapshot } from "../../filesystem/services/visibility/service.js";
import { createFindEntry, rankFindSuggestions } from "../find/ranker.js";
import type { FindEntry } from "../types.js";
import type { VisibilitySnapshot } from "../../filesystem/contracts/visibility.js";
import { isBlockedPath, toolPathIdentity, type FileToolsConfig } from "../config.js";

interface WalkCtx {
	files: string[];
	maxEntries: number;
	workspaceRoot: string;
	config: FileToolsConfig | undefined;
	ignoreSnapshot: VisibilitySnapshot | undefined;
}

/** 轻量递归遍历 workspace，收集文件路径；达到 maxEntries 后停止。 */
async function walkDirectory(dir: string, ctx: WalkCtx): Promise<void> {
	if (ctx.files.length >= ctx.maxEntries) return;

	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (ctx.files.length >= ctx.maxEntries) break;

		const full = path.join(dir, entry.name);
		const workspaceRel = path.relative(ctx.workspaceRoot, full);

		if (entry.isDirectory()) {
			if (isDirSkipped(workspaceRel, full, ctx.config, ctx.ignoreSnapshot)) continue;
			await walkDirectory(full, ctx);
		} else if (entry.isFile()) {
			ctx.files.push(full);
		}
		// Skip symlinks and other types.
	}
}

function isDirSkipped(
	workspaceRel: string,
	fullPath: string,
	config: FileToolsConfig | undefined,
	ignoreSnapshot: VisibilitySnapshot | undefined,
): boolean {
	if (config === undefined) {
		// Degraded mode: only skip .git
		return workspaceRel.split(/[\\/]+/).some((segment) => segment === ".git");
	}
	const identity = toolPathIdentity(workspaceRel, fullPath, workspaceRel);
	if (isBlockedPath(config, identity)) return true;
	if (ignoreSnapshot !== undefined) {
		const decision = ignoreSnapshot.evaluate({ path: workspaceRel, absolutePath: fullPath, workspacePath: workspaceRel, kind: "directory", intent: "traverse" });
		if (decision.ignored && decision.prune) return true;
	}
	return false;
}

function isFileSkipped(
	workspaceRel: string,
	fullPath: string,
	config: FileToolsConfig | undefined,
	ignoreSnapshot: VisibilitySnapshot | undefined,
): boolean {
	if (config === undefined) return false;
	const identity = toolPathIdentity(workspaceRel, fullPath, workspaceRel);
	if (isBlockedPath(config, identity)) return true;
	if (ignoreSnapshot !== undefined) {
		const decision = ignoreSnapshot.evaluate({ path: workspaceRel, absolutePath: fullPath, workspacePath: workspaceRel, kind: "file", intent: "search" });
		if (decision.ignored) return true;
	}
	return false;
}

/** Repo-map query surface for path suggestions — minimal interface to avoid coupling. */
export interface PathSuggestionQuery {
	query(input: { requestedPath: string; query: string; limit: number }): Promise<{
		candidates: readonly { path: string; score: number; hop: 0 | 1 | 2 }[];
	} | undefined>;
}

/** 收集 workspace 中的文件路径并返回 fuzzy 匹配建议。扫描异常时安全退化为空数组。 */
export async function findPathSuggestions(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig | undefined,
	repoMap: PathSuggestionQuery | undefined,
	maxEntries = 10_000,
	limit = 3,
): Promise<string[]> {
	// Repo-map first — O(1) in-memory query, returns file-level matches only.
	if (repoMap !== undefined) {
		try {
			const result = await repoMap.query({ requestedPath: workspaceRoot, query: inputPath, limit });
			if (result !== undefined) {
				// Only use hop=0 candidates (direct file matches), exclude symbol/graph hops.
				const paths = result.candidates
					.filter((c): c is typeof c & { hop: 0 } => c.hop === 0)
					.slice(0, limit)
					.map((c) => c.path);
				if (paths.length > 0) return paths;
			}
		} catch {
			// Repo-map query failure degrades gracefully — falls through to filesystem walk.
		}
	}

	const files: string[] = [];

	let ignoreSnapshot: VisibilitySnapshot | undefined;
	if (config !== undefined) {
		try {
			ignoreSnapshot = await createVisibilitySnapshot(workspaceRoot, config.filesystem.visibility);
		} catch {
			// Ignore snapshot build failure degrades gracefully — scan continues without gitignore filtering.
		}
	}

	const ctx: WalkCtx = {
		files,
		maxEntries,
		workspaceRoot,
		config,
		ignoreSnapshot,
	};

	await walkDirectory(workspaceRoot, ctx);

	if (files.length === 0) return [];

	const entries: FindEntry[] = [];
	for (const file of files) {
		const relative = path.relative(workspaceRoot, file);
		if (relative.startsWith("..")) continue;
		if (isFileSkipped(relative, file, config, ignoreSnapshot)) continue;
		entries.push(createFindEntry(relative, "file"));
	}

	if (entries.length === 0) return [];

	const ranked = rankFindSuggestions(entries, inputPath, ".");
	return ranked.slice(0, limit).map((item) => item.entry.path);
}
