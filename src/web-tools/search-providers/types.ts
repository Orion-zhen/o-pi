import type { FormalWebSearchProviderId, WebSearchExecutionContext, WebSearchFailureDetails, WebSearchFreshness, WebSearchItem, WebSearchProviderId } from "../types.js";

export type SearchIntent = "exact" | "navigation" | "news" | "fact" | "paper" | "semantic" | "general";

export interface CompiledSearchQuery {
	originalQuery: string;
	lexicalQuery: string;
	semanticQuery: string;
	intent: SearchIntent;
	includeDomains: string[];
	excludeDomains: string[];
	freshness?: WebSearchFreshness;
	keyTerms: string[];
	navigation: boolean;
}

/** Provider 已校验的搜索参数；limit 总是落在公开 schema 允许范围内。 */
export interface NormalizedSearchParams {
	query: string;
	limit: number;
	freshness?: WebSearchFreshness;
	includeDomains: string[];
	excludeDomains: string[];
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
			requestId?: string;
	  }
	| {
			status: "failed";
			provider: WebSearchProviderId;
			details: WebSearchFailureDetails;
	  }
	| {
			status: "skipped";
			provider: WebSearchProviderId;
			reason: string;
	  };

/** 搜索 provider 最小接口；close 用于释放 MCP 连接等长生命周期资源。 */
export interface WebSearchProvider {
	id: WebSearchProviderId;
	configured?: () => boolean;
	search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult>;
	close?(): Promise<void>;
}

export interface RankedSearchItem extends WebSearchItem {
	provenance: Array<{ provider: FormalWebSearchProviderId; rank: number }>;
}
