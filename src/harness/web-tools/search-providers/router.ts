import type { WebSearchFailureDetails, WebSearchProviderAttempt, WebSearchProviderRole, WebSearchSuccessDetails } from "../core/types.ts";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.ts";

type ProviderOutcome = { result: SearchProviderResult; attempt: WebSearchProviderAttempt };

export type SearchRouterResult =
	| { status: "success"; providers: WebSearchSuccessDetails["providers"]; results: WebSearchSuccessDetails["results"]; downloadedBytes: number; attempts: WebSearchProviderAttempt[] }
	| { status: "failed"; details: WebSearchFailureDetails };

export interface SearchProviderGroups {
	primary: readonly WebSearchProvider[];
	auxiliary: readonly WebSearchProvider[];
}

/** 主组串行回退，辅助组并发补充。合并顺序不依赖请求完成顺序。 */
export class SearchProviderRouter {
	constructor(private readonly providers: SearchProviderGroups) {}

	async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchRouterResult> {
		const stopped = interruption(params.query, context);
		if (stopped !== undefined) return failure(stopped, []);
		const controller = new AbortController();
		const requestContext = { ...context, signal: context.signal === undefined ? controller.signal : AbortSignal.any([context.signal, controller.signal]) };
		try {
			const [primary, auxiliary] = await Promise.all([
				this.searchPrimary(params, requestContext),
				Promise.all(this.providers.auxiliary.map((provider) => request(provider, "auxiliary", params, requestContext))),
			]);
			const outcomes = [...primary, ...auxiliary.filter((outcome): outcome is ProviderOutcome => outcome !== undefined)];
			const attempts = outcomes.map(({ attempt }) => attempt);
			const stoppedAfterRequests = interruption(params.query, context);
			if (stoppedAfterRequests?.error.code === "ABORTED") return failure(stoppedAfterRequests, attempts);
			const results: WebSearchSuccessDetails["results"] = [];
			const providers: WebSearchSuccessDetails["providers"] = [];
			const seen = new Set<string>();
			let downloadedBytes = 0;
			let lastFailure: WebSearchFailureDetails | undefined;
			for (const { result } of outcomes) {
				if (result.status === "failed") {
					if (result.details.error.code === "ABORTED") return failure(result.details, attempts);
					lastFailure = result.details;
					continue;
				}
				downloadedBytes += result.downloadedBytes;
				for (const item of result.results) {
					if (seen.has(item.url) || results.length >= params.limit) continue;
					seen.add(item.url);
					results.push({ ...item, rank: results.length + 1, provider: result.provider });
					if (!providers.includes(result.provider)) providers.push(result.provider);
				}
			}
			if (results.length > 0) return { status: "success", providers, results, downloadedBytes, attempts };
			return failure(stoppedAfterRequests ?? lastFailure ?? {
				status: "failed", query: params.query,
				error: { code: "NO_PROVIDER_AVAILABLE", message: "no search provider produced usable results." },
			}, attempts);
		} finally {
			controller.abort();
		}
	}

	private async searchPrimary(params: NormalizedSearchParams, context: SearchProviderContext): Promise<ProviderOutcome[]> {
		const outcomes: ProviderOutcome[] = [];
		for (const provider of this.providers.primary) {
			const outcome = await request(provider, "primary", params, context);
			if (outcome === undefined) break;
			outcomes.push(outcome);
			const { result } = outcome;
			if (result.status === "success" ? result.results.length > 0 : result.details.error.code === "ABORTED") break;
		}
		return outcomes;
	}
}

async function request(provider: WebSearchProvider, role: WebSearchProviderRole, params: NormalizedSearchParams, context: SearchProviderContext): Promise<ProviderOutcome | undefined> {
	if (interruption(params.query, context) !== undefined) return undefined;
	const started = context.now();
	const limit = Math.min(params.limit, provider.maxResults);
	const response = await provider.search({ ...params, limit }, context);
	const stopped = interruption(params.query, context);
	const result: SearchProviderResult = stopped !== undefined
		? { status: "failed", provider: provider.id, details: stopped }
		: response.status === "success"
			? { ...response, results: response.results.filter((item) => matchesDomains(item.url, params)).slice(0, limit) }
			: response;
	const duration_ms = context.now() - started;
	const attempt: WebSearchProviderAttempt = result.status === "failed"
		? { provider: provider.id, role, status: "failed", duration_ms, error: result.details.error,
			...(result.details.http_status !== undefined ? { http_status: result.details.http_status } : {}) }
		: { provider: provider.id, role, status: "success", duration_ms, result_count: result.results.length };
	return { result, attempt };
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
