import type { Dispatcher } from "undici";
import type { WebHttpFetch } from "../network/types.js";
import type { WebToolsConfig } from "../config-types.js";

import type {
	WebFetchExecutionContext,
	WebFetchParams,
	WebFetchResult,
	WebSearchExecutionContext,
	WebSearchParams,
	WebSearchResult,
} from "./types.js";

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
