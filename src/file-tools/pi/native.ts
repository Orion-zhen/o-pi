import { ReadVersionCache } from "../core/read-cache.js";
import type { LsSuccess } from "../types.js";

export function versionCacheFor(ctx: { sessionManager: { getSessionId(): string } }, caches: Map<string, ReadVersionCache>): ReadVersionCache {
	const sessionId = ctx.sessionManager.getSessionId();
	const existing = caches.get(sessionId);
	if (existing !== undefined) return existing;
	const created = new ReadVersionCache();
	caches.set(sessionId, created);
	return created;
}

type NativeLsDetails = LsSuccess & {
	/** Pi 内置 ls renderer 识别的条目上限标记。 */
	entryLimitReached?: number;
};

export function withNativeLsDetails(result: LsSuccess): NativeLsDetails {
	if (!result.truncated) return result;
	return {
		...result,
		entryLimitReached: result.returned_entries ?? result.entries.length,
	};
}
