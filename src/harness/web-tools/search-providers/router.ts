import type { WebSearchProviderAttempt, WebSearchProviderId, WebSearchProviderRole, WebSearchSuccessDetails } from "../core/types.ts";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderFailure, SearchProviderResult, WebSearchProvider } from "./types.ts";

type ProviderOutcome = { result: SearchProviderResult; attempt: WebSearchProviderAttempt };

export type SearchRouterResult =
	| { status: "success"; providers: WebSearchSuccessDetails["providers"]; results: WebSearchSuccessDetails["results"]; downloaded_bytes: number; attempts: WebSearchProviderAttempt[] }
	| (SearchProviderFailure & { provider?: WebSearchProviderId; attempts: WebSearchProviderAttempt[] });

interface SearchProviderGroups {
	primary: readonly WebSearchProvider[];
	auxiliary: readonly WebSearchProvider[];
}

/** 主组串行回退，辅助组并发补充。合并顺序不依赖请求完成顺序。 */
export async function searchProviders(providers: SearchProviderGroups, params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchRouterResult> {
	const stopped = interruption(context);
	if (stopped !== undefined) return { ...stopped, attempts: [] };
	const controller = new AbortController();
	const requestContext = { ...context, signal: AbortSignal.any([context.signal, controller.signal]) };
	try {
		const [primary, auxiliary] = await Promise.all([
			searchPrimary(providers.primary, params, requestContext),
			Promise.all(providers.auxiliary.map((provider) => request(provider, "auxiliary", params, requestContext))),
		]);
		const outcomes = [...primary, ...auxiliary.filter((outcome): outcome is ProviderOutcome => outcome !== undefined)];
		const attempts = outcomes.map(({ attempt }) => attempt);
		const stoppedAfterRequests = interruption(context);
		if (stoppedAfterRequests?.error.code === "ABORTED") return { ...stoppedAfterRequests, attempts };
		const results: WebSearchSuccessDetails["results"] = [];
		const sources: WebSearchProviderId[] = [];
		const seen = new Set<string>();
		let downloaded_bytes = 0;
		let lastFailure: (SearchProviderFailure & { provider: WebSearchProviderId }) | undefined;
		for (const { result, attempt } of outcomes) {
			if (result.status === "failed") {
				if (result.error.code === "ABORTED") return { ...result, provider: attempt.provider, attempts };
				lastFailure = { ...result, provider: attempt.provider };
				continue;
			}
			downloaded_bytes += result.downloadedBytes;
			for (const item of result.results) {
				if (seen.has(item.url) || results.length >= params.limit) continue;
				seen.add(item.url);
				results.push({ ...item, rank: results.length + 1, provider: attempt.provider });
				if (!sources.includes(attempt.provider)) sources.push(attempt.provider);
			}
		}
		if (results.length > 0) return { status: "success", providers: sources, results, downloaded_bytes, attempts };
		return { ...stoppedAfterRequests ?? lastFailure ?? {
			status: "failed", error: { code: "NO_PROVIDER_AVAILABLE", message: "no search provider produced usable results." },
		}, attempts };
	} finally {
		controller.abort();
	}
}

async function searchPrimary(providers: readonly WebSearchProvider[], params: NormalizedSearchParams, context: SearchProviderContext): Promise<ProviderOutcome[]> {
	const outcomes: ProviderOutcome[] = [];
	for (const provider of providers) {
		const outcome = await request(provider, "primary", params, context);
		if (outcome === undefined) break;
		outcomes.push(outcome);
		const { result } = outcome;
		if (result.status === "success" ? result.results.length > 0 : result.error.code === "ABORTED") break;
	}
	return outcomes;
}

async function request(provider: WebSearchProvider, role: WebSearchProviderRole, params: NormalizedSearchParams, context: SearchProviderContext): Promise<ProviderOutcome | undefined> {
	if (interruption(context) !== undefined) return undefined;
	const started = context.now();
	const limit = Math.min(params.limit, provider.maxResults);
	const response = await provider.search({ ...params, limit }, context);
	const stopped = interruption(context);
	const result: SearchProviderResult = stopped ?? (response.status === "success"
		? { ...response, results: response.results.filter((item) => matchesDomains(item.url, params)).slice(0, limit) }
		: response);
	const duration_ms = context.now() - started;
	const attempt: WebSearchProviderAttempt = result.status === "failed"
		? { provider: provider.id, role, status: "failed", duration_ms, error: result.error,
			...(result.http_status !== undefined ? { http_status: result.http_status } : {}) }
		: { provider: provider.id, role, status: "success", duration_ms, result_count: result.results.length };
	return { result, attempt };
}

function matchesDomains(rawUrl: string, params: NormalizedSearchParams): boolean {
	const hostname = new URL(rawUrl).hostname;
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	return (params.includeDomains.length === 0 || params.includeDomains.some(matches)) && !params.excludeDomains.some(matches);
}

function interruption(context: SearchProviderContext): SearchProviderFailure | undefined {
	if (context.userSignal?.aborted) return { status: "failed", error: { code: "ABORTED", message: "websearch request was aborted." } };
	if (context.now() >= context.deadlineAt) return { status: "failed", error: { code: "TIMEOUT", message: "websearch deadline exceeded." } };
	if (context.signal.aborted) return { status: "failed", error: { code: "ABORTED", message: "websearch request was aborted." } };
	return undefined;
}
