import path from "node:path";

import type { FsOperationContext } from "../../contracts/result.js";
import type { IgnoreConfig, IgnoreDiagnostic, VisibilitySourceType } from "../../contracts/visibility.js";
import type { NativeFileSystem, NativeMetadata } from "../../platform/node/native-filesystem.js";
import {
	SOURCE_PRIORITY,
	pathDepth,
	rethrowVisibilityAbort,
	type VisibilityDirectoryStamp,
	type VisibilityRuleFile,
} from "./model.js";

const RULE_DISCOVERY_CONCURRENCY = 32;

export interface VisibilityRuleDiscovery {
	readonly ruleFiles: readonly VisibilityRuleFile[];
	readonly directories: readonly VisibilityDirectoryStamp[];
	readonly diagnostics: readonly IgnoreDiagnostic[];
}

export async function discoverVisibilityRules(
	native: NativeFileSystem,
	root: string,
	config: IgnoreConfig,
	context: FsOperationContext,
): Promise<VisibilityRuleDiscovery> {
	const ruleFiles: VisibilityRuleFile[] = [];
	const directories: VisibilityDirectoryStamp[] = [];
	await collectNestedRuleFiles(native, root, config, ruleFiles, directories, context);
	if (config.gitInfoExclude) {
		await addDirectoryStamp(native, path.join(root, ".git", "info"), directories, context);
		await addRuleFile(native, root, ".git/info/exclude", "git-info-exclude", ".", ruleFiles, context);
	}
	return { ruleFiles: ruleFiles.sort(compareRuleFiles), directories, diagnostics: [] };
}

export async function visibilityStampsUnchanged(
	native: NativeFileSystem,
	directories: readonly VisibilityDirectoryStamp[],
	ruleFiles: readonly VisibilityRuleFile[],
	signal?: AbortSignal,
): Promise<boolean> {
	const stamps = [...directories, ...ruleFiles];
	const context = signal === undefined ? {} : { signal };
	for (let index = 0; index < stamps.length; index += 64) {
		const batch = stamps.slice(index, index + 64);
		const current = await Promise.all(batch.map(async (stamp) => {
			try {
				return metadataStamp(await native.lstat(stamp.absolutePath, context)) === stamp.stamp;
			} catch (error) {
				rethrowVisibilityAbort(error);
				return false;
			}
		}));
		if (current.includes(false)) return false;
	}
	return true;
}

async function collectNestedRuleFiles(
	native: NativeFileSystem,
	root: string,
	config: IgnoreConfig,
	files: VisibilityRuleFile[],
	directories: VisibilityDirectoryStamp[],
	context: FsOperationContext,
): Promise<void> {
	const pending = ["."];
	let head = 0;
	while (head < pending.length) {
		const batch = pending.slice(head, head + RULE_DISCOVERY_CONCURRENCY);
		head += batch.length;
		const discovered = await Promise.all(batch.map(async (relativeDirectory) =>
			await scanRuleDirectory(native, root, relativeDirectory, config, files, directories, context)));
		for (const children of discovered) pending.push(...children);
	}
}

async function scanRuleDirectory(
	native: NativeFileSystem,
	root: string,
	relativeDirectory: string,
	config: IgnoreConfig,
	files: VisibilityRuleFile[],
	directories: VisibilityDirectoryStamp[],
	context: FsOperationContext,
): Promise<string[]> {
	if (relativeDirectory !== "." && isWorkspaceMetadataPath(relativeDirectory)) return [];
	const absoluteDirectory = path.join(root, relativeDirectory === "." ? "" : relativeDirectory);
	let entries;
	try {
		const [listed, info] = await Promise.all([native.readdir(absoluteDirectory, context), native.lstat(absoluteDirectory, context)]);
		if (info.kind !== "directory") return [];
		entries = listed;
		directories.push(toDirectoryStamp(absoluteDirectory, info));
	} catch (error) {
		rethrowVisibilityAbort(error);
		return [];
	}

	const children: string[] = [];
	const ruleFiles: Array<Promise<void>> = [];
	for (const entry of entries) {
		const childRelative = relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
		if (entry.kind === "symlink") continue;
		if (entry.kind === "file") {
			if (config.piignore.enabled && entry.name === config.piignore.filename) {
				ruleFiles.push(addRuleFile(native, root, childRelative, "piignore", relativeDirectory, files, context));
			}
			if (config.gitignore.enabled && entry.name === ".gitignore") {
				ruleFiles.push(addRuleFile(native, root, childRelative, "gitignore", relativeDirectory, files, context));
			}
			continue;
		}
		if (entry.kind !== "directory") continue;
		if (isWorkspaceMetadataPath(childRelative) || shouldSkipRuleDiscovery(childRelative)) continue;
		const allowPiNested = config.piignore.nested || relativeDirectory === ".";
		const allowGitNested = config.gitignore.nested || relativeDirectory === ".";
		if (allowPiNested || allowGitNested) children.push(childRelative);
	}
	await Promise.all(ruleFiles);
	return children;
}

async function addRuleFile(
	native: NativeFileSystem,
	root: string,
	relativePath: string,
	sourceType: VisibilitySourceType,
	baseDirectory: string,
	files: VisibilityRuleFile[],
	context: FsOperationContext,
): Promise<void> {
	const absolutePath = path.join(root, ...relativePath.split("/"));
	try {
		const info = await native.lstat(absolutePath, context);
		if (info.kind !== "file") return;
		files.push({
			sourceType,
			sourcePath: relativePath,
			absolutePath,
			baseDirectory,
			priority: SOURCE_PRIORITY[sourceType],
			stamp: metadataStamp(info),
		});
	} catch (error) {
		rethrowVisibilityAbort(error);
	}
}

async function addDirectoryStamp(
	native: NativeFileSystem,
	absolutePath: string,
	directories: VisibilityDirectoryStamp[],
	context: FsOperationContext,
): Promise<void> {
	try {
		const info = await native.lstat(absolutePath, context);
		if (info.kind === "directory") directories.push(toDirectoryStamp(absolutePath, info));
	} catch (error) {
		rethrowVisibilityAbort(error);
		// The workspace root stamp detects a later .git directory creation.
	}
}

function toDirectoryStamp(absolutePath: string, metadata: NativeMetadata): VisibilityDirectoryStamp {
	return { absolutePath, stamp: metadataStamp(metadata) };
}

function metadataStamp(metadata: NativeMetadata): string {
	return metadata.version;
}

function compareRuleFiles(left: VisibilityRuleFile, right: VisibilityRuleFile): number {
	return left.priority - right.priority
		|| pathDepth(left.baseDirectory) - pathDepth(right.baseDirectory)
		|| left.sourcePath.localeCompare(right.sourcePath);
}

function shouldSkipRuleDiscovery(relativeDirectory: string): boolean {
	const name = relativeDirectory.split("/").at(-1);
	return name === ".git" || name === "node_modules";
}

function isWorkspaceMetadataPath(relativePath: string): boolean {
	return relativePath.split(/[\\/]+/u).some((segment) => segment === ".git");
}
