import type { Dispatcher } from "undici";

import type {
	WebFetchCapabilityOptions,
	WebSearchCapabilityOptions,
	WebToolsCapabilityLoaders,
} from "./core/runtime-types.js";
import type {
	WebHttpRequestInit,
	WebHttpResponse,
	WebToolsConfig,
	WebToolsRuntime,
	WebToolsRuntimeOptions,
} from "./core/types.js";
import { createNetworkDispatcher, networkConfigSignature } from "./network/dispatcher.js";

const defaultCapabilityLoaders: WebToolsCapabilityLoaders = {
	async search(options) {
		return (await import("./search/websearch-runtime.js")).createWebSearchRuntime(options);
	},
	async fetch(options) {
		return (await import("./fetch/webfetch-runtime.js")).createWebFetchRuntime(options);
	},
};

/** Lightweight owner for capability-local state and shared secure dispatchers. */
export function createWebToolsRuntime(
	options: WebToolsRuntimeOptions = {},
	loaders: WebToolsCapabilityLoaders = defaultCapabilityLoaders,
): WebToolsRuntime {
	const injectedDispatcher = options.dispatcher;
	const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
	const activeCalls = new Set<Promise<void>>();
	let configModulePromise: Promise<typeof import("./config.js")> | undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const sharedOptions = {
		getDispatcher,
		fetchImpl,
		loadConfig,
		now,
	};
	const searchOptions: WebSearchCapabilityOptions = {
		...sharedOptions,
		...(options.searchProviders !== undefined ? { searchProviders: options.searchProviders } : {}),
	};
	const fetchOptions: WebFetchCapabilityOptions = {
		...sharedOptions,
		...(options.cookiePath !== undefined ? { cookiePath: options.cookiePath } : {}),
	};
	const search = createMemoizedCapability(() => loaders.search(searchOptions));
	const fetch = createMemoizedCapability(() => loaders.fetch(fetchOptions));

	function getDispatcher(network: WebToolsConfig["network"]): Promise<Dispatcher> {
		if (injectedDispatcher !== undefined) return Promise.resolve(injectedDispatcher);
		const key = networkConfigSignature(network);
		const existing = dispatcherPromises.get(key);
		if (existing !== undefined) return existing;
		const pending = createDefaultDispatcher(structuredClone(network));
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
			return trackCall(async () => (await search.get()).search(params, context));
		},
		fetch(params, context) {
			assertOpen();
			return trackCall(async () => (await fetch.get()).fetch(params, context));
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
		const [searchRuntime, fetchRuntime] = await Promise.all([
			settledCapability(search.current()),
			settledCapability(fetch.current()),
		]);
		await Promise.all([searchRuntime?.close(), fetchRuntime?.close()]);
		search.clear();
		fetch.clear();
		const activeDispatchers = injectedDispatcher === undefined
			? await Promise.all([...dispatcherPromises.values()].map(settledDispatcher))
			: [injectedDispatcher];
		await Promise.all(activeDispatchers.filter((active): active is Dispatcher => active !== undefined).map((active) => active.close()));
		dispatcherPromises.clear();
	}
}

interface MemoizedCapability<T> {
	get(): Promise<T>;
	current(): Promise<T> | undefined;
	clear(): void;
}

function createMemoizedCapability<T>(load: () => Promise<T>): MemoizedCapability<T> {
	let pending: Promise<T> | undefined;
	return {
		get() {
			if (pending !== undefined) return pending;
			pending = load();
			return pending;
		},
		current: () => pending,
		clear() {
			pending = undefined;
		},
	};
}

async function settledCapability<T>(pending: Promise<T> | undefined): Promise<T | undefined> {
	return pending === undefined ? undefined : pending.catch(() => undefined);
}

async function settledDispatcher(pending: Promise<Dispatcher> | undefined): Promise<Dispatcher | undefined> {
	return pending === undefined ? undefined : pending.catch(() => undefined);
}

async function createDefaultDispatcher(network: WebToolsConfig["network"]): Promise<Dispatcher> {
	return createNetworkDispatcher(network, await loadUndici());
}

async function defaultFetch(input: URL, init: WebHttpRequestInit): Promise<WebHttpResponse> {
	const { fetch: undiciFetch } = await loadUndici();
	const response = await undiciFetch(input, init);
	return {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		body: response.body,
	};
}

let undiciModule: Promise<typeof import("undici")> | undefined;

function loadUndici(): Promise<typeof import("undici")> {
	undiciModule ??= import("undici");
	return undiciModule;
}
