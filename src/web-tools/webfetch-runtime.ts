import { runtimeConfigFailure } from "./runtime-errors.js";
import type { WebFetchCapability, WebFetchCapabilityOptions } from "./runtime-types.js";
import { SnapshotCache } from "./snapshot-cache.js";
import type { CookieStore, WebToolsConfig } from "./types.js";
import { executeWebFetch } from "./webfetch-tool.js";

/** Fetch-only session state. Search-only sessions never import CookieJar or the fetch execution graph. */
export function createWebFetchRuntime(options: WebFetchCapabilityOptions): WebFetchCapability {
	const snapshots = new SnapshotCache(options.now);
	const approvedAuthOrigins = new Set<string>();
	const cookieStore = createLazyCookieStore(() => createCookieStore(options.cookiePath));

	return {
		async fetch(params, context) {
			const dispatcherPromise = options.getDispatcher();
			let config: WebToolsConfig;
			try {
				config = await options.loadConfig();
			} catch (error) {
				void dispatcherPromise.catch(() => undefined);
				return runtimeConfigFailure("webfetch", error);
			}
			options.setAllowedFakeIpRanges(config.network.fake_ip_ranges);
			const dispatcher = await dispatcherPromise;
			return executeWebFetch(params, {
				dispatcher,
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

export function createLazyCookieStore(load: () => Promise<CookieStore>): LazyCookieStore {
	let storePromise: Promise<CookieStore> | undefined;
	const getStore = (): Promise<CookieStore> => {
		if (storePromise !== undefined) return storePromise;
		const pending = load();
		storePromise = pending;
		void pending.catch(() => {
			if (storePromise === pending) storePromise = undefined;
		});
		return pending;
	};
	return {
		async getCookieAccess(url, allowlisted) {
			if (!allowlisted) return { fingerprint: "disabled", authenticated: false };
			return (await getStore()).getCookieAccess(url, true);
		},
		async storeFromResponse(url, headers, allowlisted) {
			if (!allowlisted || headers.length === 0) return undefined;
			return (await getStore()).storeFromResponse(url, headers, true);
		},
		clear() {
			storePromise = undefined;
		},
	};
}

async function createCookieStore(cookiePath: string | undefined): Promise<CookieStore> {
	const storeModule = import("./cookie-store.js");
	const resolvedPath = cookiePath ?? (await import("./config.js")).defaultCookiePath();
	const { NetscapeCookieStore } = await storeModule;
	return new NetscapeCookieStore(resolvedPath);
}
