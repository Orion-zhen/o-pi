import { runtimeConfigFailure } from "../core/runtime-errors.ts";
import type { WebFetchCapability, WebCapabilityOptions } from "../core/runtime-types.ts";
import { SnapshotCache } from "./snapshot-cache.ts";
import type { CookieStore } from "../core/types.ts";
import type { WebToolsConfig } from "../config-types.ts";
import { executeWebFetch } from "./webfetch-tool.ts";

/** Fetch-only session state. Search-only sessions never import CookieJar or the fetch execution graph. */
export function createWebFetchRuntime(options: WebCapabilityOptions): WebFetchCapability {
	const snapshots = new SnapshotCache(options.now);
	const approvedAuthOrigins = new Set<string>();
	const cookieStore = createLazyCookieStore();

	return {
		async fetch(params, context) {
			let config: WebToolsConfig;
			try {
				config = await options.loadConfig();
			} catch (error) {
				return runtimeConfigFailure("webfetch", error);
			}
			const [dispatcher, privateNetworkDispatcher] = await Promise.all([
				options.getDispatcher(config.network),
				context.privateNetworkGrant === undefined
					? undefined
					: options.getDispatcher(config.network, context.privateNetworkGrant),
			]);
			return executeWebFetch(params, {
				dispatcher,
				...(privateNetworkDispatcher !== undefined ? { privateNetworkDispatcher } : {}),
				fetchImpl: options.fetchImpl,
				cookieStore,
				snapshots,
				approvedAuthOrigins,
				config,
				context,
				now: options.now,
			});
		},
		async close() {
			snapshots.clear();
			approvedAuthOrigins.clear();
			cookieStore.clear();
		},
	};
}

interface LazyCookieStore extends CookieStore {
	clear(): void;
}

function createLazyCookieStore(): LazyCookieStore {
	let storePromise: Promise<CookieStore> | undefined;
	const getStore = (): Promise<CookieStore> => {
		if (storePromise !== undefined) return storePromise;
		storePromise = createCookieStore();
		return storePromise;
	};
	return {
		async getCookieAccess(url) {
			return (await getStore()).getCookieAccess(url);
		},
		async storeFromResponse(url, headers) {
			if (headers.length === 0) return undefined;
			return (await getStore()).storeFromResponse(url, headers);
		},
		clear() {
			storePromise = undefined;
		},
	};
}

async function createCookieStore(): Promise<CookieStore> {
	const storeModule = import("./cookie-store.ts");
	const resolvedPath = (await import("../config.ts")).defaultCookiePath();
	const { NetscapeCookieStore } = await storeModule;
	return new NetscapeCookieStore(resolvedPath);
}
