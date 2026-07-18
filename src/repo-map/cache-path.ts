import path from "node:path";

import { expandHomePath, userCachePath } from "../cache-path.js";

const CACHE_DIR_ENV = "PI_REPO_MAP_CACHE_DIR";

export function repoMapCacheRoot(): string {
	return path.resolve(expandHomePath(process.env[CACHE_DIR_ENV] ?? userCachePath("repo-map")));
}
