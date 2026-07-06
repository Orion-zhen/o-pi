import type { WebSearchExecutionContext, WebSearchFailureDetails, WebSearchItem, WebSearchProviderId } from "../types.js";

/** Provider 已校验的搜索参数；limit 总是落在公开 schema 允许范围内。 */
export interface NormalizedSearchParams {
	query: string;
	limit: number;
}

/** Provider 执行上下文；progress 由具体 provider 映射到 Pi update。 */
export interface SearchProviderContext {
	signal?: AbortSignal;
	now: () => number;
	onUpdate?: WebSearchExecutionContext["onUpdate"];
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
	| {
			status: "skipped";
			provider: WebSearchProviderId;
			reason: string;
	  };

/** 搜索 provider 最小接口；close 用于释放 MCP 连接等长生命周期资源。 */
export interface WebSearchProvider {
	id: WebSearchProviderId;
	search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult>;
	close?(): Promise<void>;
}
