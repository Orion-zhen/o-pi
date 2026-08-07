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
import { SearchCorpus } from "./search/search-corpus.js";

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
	let configModulePromise: Promise<typeof import("./config.js")> | undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const searchCorpus = new SearchCorpus(now);
	const sharedOptions = {
		getDispatcher,
		fetchImpl,
		loadConfig,
		now,
		searchCorpus,
	};
	const searchOptions: WebSearchCapabilityOptions = {
		...sharedOptions,
		...(options.searchProviders !== undefined ? { searchProviders: options.searchProviders } : {}),
	};
	const fetchOptions: WebFetchCapabilityOptions = {
		...sharedOptions,
		...(options.cookiePath !== undefined ? { cookiePath: options.cookiePath } : {}),
	};
	const search = createRetryableCapability(() => loaders.search(searchOptions));
	const fetch = createRetryableCapability(() => loaders.fetch(fetchOptions));

	function getDispatcher(network: WebToolsConfig["network"]): Promise<Dispatcher> {
		if (injectedDispatcher !== undefined) return Promise.resolve(injectedDispatcher);
		const key = networkConfigSignature(network);
		const existing = dispatcherPromises.get(key);
		if (existing !== undefined) return existing;
		const pending = createDefaultDispatcher(structuredClone(network));
		dispatcherPromises.set(key, pending);
		void pending.catch(() => {
			if (dispatcherPromises.get(key) === pending) dispatcherPromises.delete(key);
		});
		return pending;
	}

	async function loadConfig(): Promise<WebToolsConfig> {
		let modulePromise = configModulePromise;
		if (modulePromise === undefined) {
			const pending = import("./config.js");
			configModulePromise = pending;
			void pending.catch(() => {
				if (configModulePromise === pending) configModulePromise = undefined;
			});
			modulePromise = pending;
		}
		return (await modulePromise).loadWebToolsConfig();
	}

	function assertOpen(): void {
		if (closed) throw new Error("web-tools runtime is closed");
	}

	return {
		async search(params, context) {
			assertOpen();
			return (await search.get()).search(params, context);
		},
		async fetch(params, context) {
			assertOpen();
			searchCorpus.markFetched(params.url);
			return (await fetch.get()).fetch(params, context);
		},
		observeCitations(text) {
			for (const match of text.matchAll(/https?:\/\/[^\s<>)\]"']+/gu)) searchCorpus.markCited(match[0].replace(/[.,;:!?]+$/u, ""));
		},
		close() {
			if (closePromise !== undefined) return closePromise;
			closed = true;
			closePromise = closeRuntime();
			return closePromise;
		},
	};

	async function closeRuntime(): Promise<void> {
		const [searchRuntime, fetchRuntime] = await Promise.all([
			settledCapability(search.current()),
			settledCapability(fetch.current()),
		]);
		await Promise.all([searchRuntime?.close(), fetchRuntime?.close()]);
		search.clear();
		fetch.clear();
		searchCorpus.clear();
		const activeDispatchers = injectedDispatcher === undefined
			? await Promise.all([...dispatcherPromises.values()].map(settledDispatcher))
			: [injectedDispatcher];
		await Promise.all(activeDispatchers.filter((active): active is Dispatcher => active !== undefined).map((active) => active.close()));
		dispatcherPromises.clear();
		configModulePromise = undefined;
	}
}

interface RetryableCapability<T> {
	get(): Promise<T>;
	current(): Promise<T> | undefined;
	clear(): void;
}

function createRetryableCapability<T>(load: () => Promise<T>): RetryableCapability<T> {
	let pending: Promise<T> | undefined;
	return {
		get() {
			if (pending !== undefined) return pending;
			const created = load();
			pending = created;
			void created.catch(() => {
				if (pending === created) pending = undefined;
			});
			return created;
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
