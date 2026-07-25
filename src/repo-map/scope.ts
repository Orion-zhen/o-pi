import path from "node:path";

import {
	ignoreConfigFromFileTools,
	isBlockedPath,
	isIgnoredPath,
	loadFileToolsConfig,
	toolPathIdentity,
	type FileToolsConfig,
} from "../file-tools/config.js";
import { isFailed } from "../file-tools/shared/result.js";
import { createIgnoreSnapshot } from "../file-tools/ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "../file-tools/ignore/ignore-types.js";
import { RepoMapError } from "./errors.js";

export interface RepoMapFileScopeInput {
	relativePath: string;
	absolutePath: string;
	fileToolsConfig: FileToolsConfig;
	ignoreSnapshot: IgnoreSnapshot;
}

/** 与 scanner 相同的单文件 scope 判定；不包含文件大小、类型或可读性检查。 */
export function isRepoMapFileInScope(input: RepoMapFileScopeInput): boolean {
	const identity = toolPathIdentity(input.relativePath, input.absolutePath, input.relativePath);
	return !isBlockedPath(input.fileToolsConfig, identity)
		&& !isIgnoredPath(input.fileToolsConfig, identity)
		&& !input.ignoreSnapshot.evaluate({ path: input.relativePath, kind: "file", intent: "index" }).ignored;
}

/** 判断仓库内路径当前是否属于 Repo Map 自动扫描范围。 */
export async function isRepoMapPathInScope(root: string, requestedPath: string): Promise<boolean> {
	const relativePath = relativeRepoPath(root, requestedPath);
	if (relativePath === undefined) return false;
	const fileToolsConfig = await loadFileToolsConfig(root);
	if (isFailed(fileToolsConfig)) throw new RepoMapError("CONFIG_ERROR", fileToolsConfig.error.message, fileToolsConfig.error.details);
	const ignoreSnapshot = await createIgnoreSnapshot(root, ignoreConfigFromFileTools(fileToolsConfig));
	return isRepoMapFileInScope({
		relativePath,
		absolutePath: path.resolve(requestedPath),
		fileToolsConfig,
		ignoreSnapshot,
	});
}

export function relativeRepoPath(root: string, requestedPath: string): string | undefined {
	const relative = path.relative(path.resolve(root), path.resolve(requestedPath));
	if (relative === "") return undefined;
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return relative.replaceAll(path.sep, "/");
}
