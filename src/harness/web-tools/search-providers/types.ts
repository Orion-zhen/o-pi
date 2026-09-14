import type { WebSearchExecutionContext, WebSearchFailureDetails, WebSearchItem, WebSearchProviderId } from "../core/types.js";

export type SearchIntent = "exact" | "navigation" | "news" | "fact" | "paper" | "semantic" | "general";

export interface CompiledSearchQuery {
	lexicalQuery: string;
	semanticQuery: string;
	intent: SearchIntent;
	includeDomains: string[];
	excludeDomains: string[];
	keyTerms: string[];
	navigation: boolean;
}

/** Provider 已校验的搜索参数；limit 总是落在公开 schema 允许范围内。 */
export interface NormalizedSearchParams {
	query: string;
	limit: number;
	compiled: CompiledSearchQuery;
	/** Router-only hint; never exposed in tool schema. */
	lastFormalOpportunity?: boolean;
}

/** Provider 执行上下文；progress 由具体 provider 映射到 Pi update。 */
export interface SearchProviderContext {
	signal?: AbortSignal;
	userSignal?: AbortSignal;
	now: () => number;
	onUpdate?: WebSearchExecutionContext["onUpdate"];
	deadlineAt?: number;
}

export type SearchProviderResult =
	| {
			status: "success";
			provider: WebSearchProviderId;
			results: WebSearchItem[];
			downloadedBytes: number;
	  }
	| {
			status: "failed";
			provider: WebSearchProviderId;
			details: WebSearchFailureDetails;
	  }

/** 提供方只执行请求，连接资源由共享 dispatcher 管理。 */
export interface WebSearchProvider {
	id: WebSearchProviderId;
	search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult>;
}
