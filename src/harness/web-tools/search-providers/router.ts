import type { WebSearchFailureDetails, WebSearchProviderAttempt } from "../core/types.ts";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.ts";

type ProviderSuccess = Extract<SearchProviderResult, { status: "success" }>;

export type SearchRouterResult =
	| (ProviderSuccess & { attempts: WebSearchProviderAttempt[] })
	| { status: "failed"; details: WebSearchFailureDetails };

/** 按传入顺序尝试可用提供方，首批非空结果直接返回。 */
export class SearchProviderRouter {
	constructor(private readonly providers: readonly WebSearchProvider[]) {}

	async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchRouterResult> {
		const attempts: WebSearchProviderAttempt[] = [];
		let lastFailure: WebSearchFailureDetails | undefined;
		const stopped = interruption(params.query, context);
		if (stopped !== undefined) return failure(stopped, attempts);
		for (const provider of this.providers) {
			const { id } = provider;
			const started = context.now();
			const response = await provider.search(params, context);
			const duration = context.now() - started;
			const result = response.status === "success"
				? { ...response, results: response.results.filter((item) => matchesDomains(item.url, params)).slice(0, params.limit) }
				: response;
			attempts.push(result.status === "failed" ? {
				provider: id, status: "failed", duration_ms: duration, error: result.details.error,
				...(result.details.http_status !== undefined ? { http_status: result.details.http_status } : {}),
			} : { provider: id, status: "success", duration_ms: duration, result_count: result.results.length });
			const stoppedAfterRequest = interruption(params.query, context);
			if (stoppedAfterRequest !== undefined) return failure(stoppedAfterRequest, attempts);
			if (result.status === "failed") {
				if (result.details.error.code === "ABORTED") return failure(result.details, attempts);
				lastFailure = result.details;
			} else if (result.results.length > 0) {
				return { ...result, results: result.results.map((item, index) => ({ ...item, rank: index + 1 })), attempts };
			}
		}
		return failure(lastFailure ?? {
			status: "failed", query: params.query,
			error: { code: "NO_PROVIDER_AVAILABLE", message: "no search provider produced usable results." },
		}, attempts);
	}
}

function matchesDomains(rawUrl: string, params: NormalizedSearchParams): boolean {
	const hostname = new URL(rawUrl).hostname;
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	return (params.includeDomains.length === 0 || params.includeDomains.some(matches)) && !params.excludeDomains.some(matches);
}

function interruption(query: string, context: SearchProviderContext): WebSearchFailureDetails | undefined {
	if (context.userSignal?.aborted) return { status: "failed", query, error: { code: "ABORTED", message: "websearch request was aborted." } };
	if (context.deadlineAt !== undefined && context.now() >= context.deadlineAt) {
		return { status: "failed", query, error: { code: "TIMEOUT", message: "websearch deadline exceeded." } };
	}
	if (context.signal?.aborted) return { status: "failed", query, error: { code: "ABORTED", message: "websearch request was aborted." } };
	return undefined;
}

function failure(details: WebSearchFailureDetails, attempts: WebSearchProviderAttempt[]): SearchRouterResult {
	return { status: "failed", details: { ...details, attempts } };
}
