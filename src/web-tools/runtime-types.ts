import type { Dispatcher } from "undici";

import type { WebSearchProvider } from "./search-providers/types.js";
import type { SearchCorpus } from "./search-corpus.js";
import type {
	WebFetchExecutionContext,
	WebFetchParams,
	WebFetchResult,
	WebHttpFetch,
	WebSearchExecutionContext,
	WebSearchParams,
	WebSearchResult,
	WebToolsConfig,
} from "./types.js";

export interface WebCapabilitySharedOptions {
	getDispatcher(): Promise<Dispatcher>;
	fetchImpl: WebHttpFetch;
	loadConfig(): Promise<WebToolsConfig>;
	now: () => number;
	setAllowedFakeIpRanges(ranges: readonly string[]): void;
	searchCorpus: SearchCorpus;
}

export interface WebSearchCapabilityOptions extends WebCapabilitySharedOptions {
	searchProviders?: WebSearchProvider[];
}

export interface WebFetchCapabilityOptions extends WebCapabilitySharedOptions {
	cookiePath?: string;
}

export interface WebSearchCapability {
	search(params: WebSearchParams, context: WebSearchExecutionContext): Promise<WebSearchResult>;
	close(): Promise<void>;
}

export interface WebFetchCapability {
	fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult>;
	close(): Promise<void>;
}

export interface WebToolsCapabilityLoaders {
	search(options: WebSearchCapabilityOptions): Promise<WebSearchCapability>;
	fetch(options: WebFetchCapabilityOptions): Promise<WebFetchCapability>;
}
