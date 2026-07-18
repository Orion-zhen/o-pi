import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RepoMapActivation } from "./activation.js";
import { repoMapCacheRoot } from "./cache-path.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** Lightweight unavailable check used before loading the Repo Map service and graph validators. */
export async function isActivatedGenerationCurrent(activation: RepoMapActivation): Promise<boolean> {
	if (!HASH_PATTERN.test(activation.mapId) || !HASH_PATTERN.test(activation.generation)) return false;
	try {
		const current = (await readFile(path.join(repoMapCacheRoot(), activation.mapId, "CURRENT"), "utf8")).trim();
		return current === activation.generation;
	} catch {
		return false;
	}
}
