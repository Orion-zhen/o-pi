import type { SearchProviderConfig } from "../config-types.ts";
import type { WebSearchErrorCode, WebSearchExecutionContext, WebSearchItem, WebSearchProviderId } from "../core/types.ts";

/** 已校验的搜索参数，limit 落在公开 schema 允许范围内。 */
export interface NormalizedSearchParams {
	query: string;
	limit: number;
	textQuery: string;
	includeDomains: string[];
	excludeDomains: string[];
}

/** 只保存本次请求可用的提供方及已解析凭据。 */
export type ResolvedApiProvider = { config: SearchProviderConfig } & (
	| { id: Exclude<WebSearchProviderId, "exa_mcp" | "anysearch">; key: string }
	| { id: "anysearch"; key: string | undefined }
);

export type ResolvedSearchProvider = ResolvedApiProvider | { id: "exa_mcp"; config: SearchProviderConfig };

/** 提供方执行上下文，进度由具体提供方映射到工具更新。 */
export interface SearchProviderContext {
	signal: AbortSignal;
	userSignal?: AbortSignal;
	now: () => number;
	onUpdate?: WebSearchExecutionContext["onUpdate"];
	deadlineAt: number;
}

export interface SearchProviderFailure {
	status: "failed";
	error: { code: WebSearchErrorCode; message: string };
	http_status?: number;
}

export type SearchProviderResult =
	| { status: "success"; results: WebSearchItem[]; downloadedBytes: number }
	| SearchProviderFailure;

/** 提供方只执行请求，连接资源由共享 dispatcher 管理。 */
export interface WebSearchProvider {
	id: WebSearchProviderId;
	maxResults: number;
	search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult>;
}
