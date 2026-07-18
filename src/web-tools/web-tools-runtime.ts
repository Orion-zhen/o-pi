import type { Dispatcher } from "undici";

import type {
	WebFetchCapabilityOptions,
	WebSearchCapabilityOptions,
	WebToolsCapabilityLoaders,
} from "./runtime-types.js";
import type {
	WebHttpRequestInit,
	WebHttpResponse,
	WebToolsConfig,
	WebToolsRuntime,
	WebToolsRuntimeOptions,
} from "./types.js";

const defaultCapabilityLoaders: WebToolsCapabilityLoaders = {
	async search(options) {
		return (await import("./websearch-runtime.js")).createWebSearchRuntime(options);
	},
	async fetch(options) {
		return (await import("./webfetch-runtime.js")).createWebFetchRuntime(options);
	},
};

/** Lightweight owner for capability-local state and the one shared secure dispatcher. */
export function createWebToolsRuntime(
	options: WebToolsRuntimeOptions = {},
	loaders: WebToolsCapabilityLoaders = defaultCapabilityLoaders,
): WebToolsRuntime {
	let allowedFakeIpRanges: readonly string[] = [];
	let dispatcher = options.dispatcher;
	let dispatcherPromise: Promise<Dispatcher> | undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const sharedOptions = {
		getDispatcher,
		fetchImpl,
		loadConfig,
		now,
		setAllowedFakeIpRanges(ranges: readonly string[]) {
			allowedFakeIpRanges = ranges;
		},
	};
	const searchOptions: WebSearchCapabilityOptions = {
		...sharedOptions,
		...(options.exaMcpClientFactory !== undefined ? { exaMcpClientFactory: options.exaMcpClientFactory } : {}),
		...(options.searchProviders !== undefined ? { searchProviders: options.searchProviders } : {}),
	};
	const fetchOptions: WebFetchCapabilityOptions = {
		...sharedOptions,
		...(options.cookiePath !== undefined ? { cookiePath: options.cookiePath } : {}),
	};
	const search = createRetryableCapability(() => loaders.search(searchOptions));
	const fetch = createRetryableCapability(() => loaders.fetch(fetchOptions));

	function getDispatcher(): Promise<Dispatcher> {
		if (dispatcher !== undefined) return Promise.resolve(dispatcher);
		if (dispatcherPromise !== undefined) return dispatcherPromise;
		const pending = createDefaultDispatcher(() => allowedFakeIpRanges);
		dispatcherPromise = pending;
		void pending.then((created) => {
			dispatcher = created;
		}, () => {
			if (dispatcherPromise === pending) dispatcherPromise = undefined;
		});
		return pending;
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
			return (await fetch.get()).fetch(params, context);
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
		const activeDispatcher = dispatcher ?? await settledDispatcher(dispatcherPromise);
		await activeDispatcher?.close();
		dispatcher = undefined;
		dispatcherPromise = undefined;
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

async function createDefaultDispatcher(getAllowedFakeIpRanges: () => readonly string[]): Promise<Dispatcher> {
	const [{ Agent }, { createSecureLookup }] = await Promise.all([
		loadUndici(),
		import("./network-policy.js"),
	]);
	return new Agent({
		connect: { lookup: createSecureLookup(getAllowedFakeIpRanges) },
	});
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

async function loadConfig(): Promise<WebToolsConfig> {
	return (await import("./config.js")).loadWebToolsConfig();
}

let undiciModule: Promise<typeof import("undici")> | undefined;

function loadUndici(): Promise<typeof import("undici")> {
	undiciModule ??= import("undici");
	return undiciModule;
}
