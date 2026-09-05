import type { Dispatcher } from "undici";

import type {
	WebFetchCapability,
	WebSearchCapability,
	WebCapabilityOptions,
} from "./core/runtime-types.js";
import type {
	WebHttpRequestInit,
	WebHttpResponse,
	WebToolsConfig,
	WebToolsRuntime,
} from "./core/types.js";
import { createNetworkDispatcher, networkConfigSignature } from "./network/dispatcher.js";
import type { PrivateNetworkGrant } from "./network/private-network-grant.js";

/** 按需初始化两条能力链，统一等待调用结束并释放共享 dispatcher。 */
export function createWebToolsRuntime(): WebToolsRuntime {
	const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
	const activeCalls = new Set<Promise<void>>();
	let configModulePromise: Promise<typeof import("./config.js")> | undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const sharedOptions: WebCapabilityOptions = {
		getDispatcher,
		fetchImpl: defaultFetch,
		loadConfig,
		now: () => Date.now(),
	};
	let searchRuntime: Promise<WebSearchCapability> | undefined;
	let fetchRuntime: Promise<WebFetchCapability> | undefined;

	function getDispatcher(
		network: WebToolsConfig["network"],
		privateNetworkGrant?: PrivateNetworkGrant,
	): Promise<Dispatcher> {
		const key = dispatcherKey(network, privateNetworkGrant);
		const existing = dispatcherPromises.get(key);
		if (existing !== undefined) return existing;
		const pending = createDefaultDispatcher(structuredClone(network), privateNetworkGrant);
		dispatcherPromises.set(key, pending);
		return pending;
	}

	async function loadConfig(): Promise<WebToolsConfig> {
		configModulePromise ??= import("./config.js");
		return (await configModulePromise).loadWebToolsConfig();
	}

	function assertOpen(): void {
		if (closed) throw new Error("web-tools runtime is closed");
	}

	function trackCall<T>(operation: () => Promise<T>): Promise<T> {
		const pending = operation();
		const settled = pending.then(() => undefined, () => undefined);
		activeCalls.add(settled);
		void settled.then(() => {
			activeCalls.delete(settled);
		});
		return pending;
	}

	return {
		search(params, context) {
			assertOpen();
			return trackCall(async () => {
				searchRuntime ??= import("./search/websearch-runtime.js").then((module) => module.createWebSearchRuntime(sharedOptions));
				return (await searchRuntime).search(params, context);
			});
		},
		fetch(params, context) {
			assertOpen();
			return trackCall(async () => {
				fetchRuntime ??= import("./fetch/webfetch-runtime.js").then((module) => module.createWebFetchRuntime(sharedOptions));
				return (await fetchRuntime).fetch(params, context);
			});
		},
		close() {
			if (closePromise !== undefined) return closePromise;
			closed = true;
			closePromise = closeRuntime();
			return closePromise;
		},
	};

	async function closeRuntime(): Promise<void> {
		await Promise.all([...activeCalls]);
		const [search, fetch] = await Promise.all([settled(searchRuntime), settled(fetchRuntime)]);
		await Promise.all([search?.close(), fetch?.close()]);
		searchRuntime = undefined;
		fetchRuntime = undefined;
		const activeDispatchers = await Promise.all([...dispatcherPromises.values()].map(settled));
		await Promise.all(activeDispatchers.filter((active): active is Dispatcher => active !== undefined).map((active) => active.close()));
		dispatcherPromises.clear();
	}
}

async function settled<T>(pending: Promise<T> | undefined): Promise<T | undefined> {
	return pending?.catch(() => undefined);
}

async function createDefaultDispatcher(
	network: WebToolsConfig["network"],
	privateNetworkGrant?: PrivateNetworkGrant,
): Promise<Dispatcher> {
	return createNetworkDispatcher(network, await loadUndici(), {
		...(privateNetworkGrant !== undefined ? { pinnedAddressSet: privateNetworkGrant } : {}),
	});
}

function dispatcherKey(network: WebToolsConfig["network"], grant?: PrivateNetworkGrant): string {
	const networkKey = networkConfigSignature(network);
	if (grant === undefined) return networkKey;
	return `${networkKey}\0${grant.origin}\0${grant.addresses.map((item) => `${item.family}:${item.address}`).join(",")}`;
}

async function defaultFetch(input: URL, init: WebHttpRequestInit): Promise<WebHttpResponse> {
	return (await loadUndici()).fetch(input, init);
}

let undiciModule: Promise<typeof import("undici")> | undefined;

function loadUndici(): Promise<typeof import("undici")> {
	undiciModule ??= import("undici");
	return undiciModule;
}
