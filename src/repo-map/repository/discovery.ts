import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { repoMapCacheRoot } from "./cache-path.js";
import { createRepoMapId } from "../core/identity.js";
import { detectRepository, readHeadRevision, type RepositoryIdentity } from "./repository.js";
import type { RepoMapFreshness } from "../core/types.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_POINTER_BYTES = 128;
const MAX_METADATA_BYTES = 64 * 1024;

export interface DiscoveredRepoMap {
	root: string;
	mapId: string;
	generation: string;
	freshness: RepoMapFreshness;
	needsRefresh: boolean;
}

interface StoredMetadata {
	mapId: string;
	repositoryRoot: string;
	worktreeRoot: string;
	gitCommonDir: string;
	generation: string;
	freshness: RepoMapFreshness;
	gitRevision?: string;
}

/** 仅执行 Git 身份探测并读取 CURRENT/metadata；不加载图快照或扫描工作区。 */
export async function discoverCurrentRepoMap(cwd: string, signal?: AbortSignal): Promise<DiscoveredRepoMap | undefined> {
	const identity = await detectRepository(cwd, signal === undefined ? { readHead: false } : { signal, readHead: false });
	const mapId = createRepoMapId(identity);
	const current = (await readSmallFile(path.join(repoMapCacheRoot(), mapId, "CURRENT"), MAX_POINTER_BYTES))?.trim();
	if (current === undefined || !HASH_PATTERN.test(current)) return undefined;
	const text = await readSmallFile(path.join(repoMapCacheRoot(), mapId, "generations", current, "metadata.json"), MAX_METADATA_BYTES);
	if (text === undefined) return undefined;
	try {
		const metadata: unknown = JSON.parse(text);
		if (!isMatchingMetadata(metadata, identity, mapId, current)) return undefined;
		const headRevision = await readHeadRevision(identity.worktreeRoot, signal === undefined ? {} : { signal });
		return {
			root: identity.repositoryRoot,
			mapId,
			generation: current,
			freshness: metadata.freshness,
			needsRefresh: metadata.freshness === "stale"
				|| metadata.freshness === "unavailable"
				|| metadata.gitRevision !== headRevision,
		};
	} catch {
		return undefined;
	}
}

async function readSmallFile(filePath: string, maxBytes: number): Promise<string | undefined> {
	try {
		const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			if ((await handle.stat()).size > maxBytes) return undefined;
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

function isMatchingMetadata(
	value: unknown,
	identity: RepositoryIdentity,
	mapId: string,
	generation: string,
): value is StoredMetadata {
	if (!isRecord(value)) return false;
	return value["mapId"] === mapId
		&& value["generation"] === generation
		&& samePath(value["repositoryRoot"], identity.repositoryRoot)
		&& samePath(value["worktreeRoot"], identity.worktreeRoot)
		&& samePath(value["gitCommonDir"], identity.gitCommonDir)
		&& isFreshness(value["freshness"])
		&& (value["gitRevision"] === undefined || typeof value["gitRevision"] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function samePath(value: unknown, expected: string): boolean {
	return typeof value === "string" && path.resolve(value) === path.resolve(expected);
}

function isFreshness(value: unknown): value is RepoMapFreshness {
	return value === "fresh" || value === "partially_stale" || value === "stale" || value === "unavailable";
}
