import type { Dispatcher } from "undici";
import type { WebHttpFetch } from "../network/types.ts";
import type { WebToolsConfig } from "../config-types.ts";

import type {
	WebFetchExecutionContext,
	WebFetchParams,
	WebFetchResult,
	WebSearchExecutionContext,
	WebSearchParams,
	WebSearchResult,
} from "./types.ts";

export interface WebCapabilityOptions {
	getDispatcher(
		network: WebToolsConfig["network"],
		privateNetworkGrant?: WebFetchExecutionContext["privateNetworkGrant"],
	): Promise<Dispatcher>;
	fetchImpl: WebHttpFetch;
	loadConfig(): Promise<WebToolsConfig>;
	now: () => number;
}

export interface WebSearchCapability {
	search(params: WebSearchParams, context: WebSearchExecutionContext): Promise<WebSearchResult>;
	close(): Promise<void>;
}

export interface WebFetchCapability {
	fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult>;
	close(): Promise<void>;
}
