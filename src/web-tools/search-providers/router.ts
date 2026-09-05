import type { FormalWebSearchProviderId, WebSearchErrorCode, WebSearchFailureDetails, WebSearchItem, WebSearchProviderAttempt, WebSearchProviderId } from "../core/types.js";
import { assessSearchQuality } from "./quality.js";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.js";

const TERMINAL_ERRORS = new Set<WebSearchErrorCode>(["ABORTED", "INVALID_ARGUMENT"]);
type ProviderSuccess = Extract<SearchProviderResult, { status: "success" }>;

export type SearchRouterResult =
	| (ProviderSuccess & { attempts: WebSearchProviderAttempt[] })
	| { status: "failed"; details: WebSearchFailureDetails };

/** 按查询意图执行最多两个正式提供方，不保留跨调用健康状态。 */
export class SearchProviderRouter {
	private readonly providers: Map<WebSearchProviderId, WebSearchProvider>;

	constructor(providers: readonly WebSearchProvider[]) {
		this.providers = new Map(providers.map((provider) => [provider.id, provider]));
	}

	async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchRouterResult> {
		const semantic = params.compiled.intent === "paper" || params.compiled.intent === "semantic";
		const order: FormalWebSearchProviderId[] = semantic
			? ["exa_api", "tavily", "brave_api"]
			: ["brave_api", "tavily", "exa_api"];
		const candidates = order.flatMap((id) => {
			const provider = this.providers.get(id);
			return provider === undefined ? [] : [{ id, provider }];
		}).slice(0, 2);
		const attempts: WebSearchProviderAttempt[] = [];
		const batches: Array<{ provider: FormalWebSearchProviderId; results: WebSearchItem[]; downloadedBytes: number }> = [];
		let lastFailure: WebSearchFailureDetails | undefined;
		if (deadlineExpired(context)) return failure(timeoutFailure(params.query), attempts);
		if (userAborted(context)) return failure(abortedFailure(params.query), attempts);

		for (const [index, { id: providerId, provider }] of candidates.entries()) {
			if (deadlineExpired(context)) {
				lastFailure = timeoutFailure(params.query);
				break;
			}
			const started = context.now();
			const result = await provider.search({ ...params, lastFormalOpportunity: index === candidates.length - 1 }, context);
			const duration = context.now() - started;
			if (result.status === "failed") {
				lastFailure = result.details;
				attempts.push(failedAttempt(providerId, result.details, duration));
				if (TERMINAL_ERRORS.has(result.details.error.code)) return failure(result.details, attempts);
				if (userAborted(context)) return failure(abortedFailure(params.query), attempts);
				continue;
			}

			const assessment = assessSearchQuality(result.results, params.compiled, params.limit);
			attempts.push({
				provider: providerId,
				status: "success",
				duration_ms: duration,
				quality: assessment.quality,
				result_count: assessment.usableResults.length,
			});
			// 首次成功批次被接受时直接返回，不改变提供方原始排序。
			if (assessment.quality === "accepted" && batches.length === 0) {
				return {
					...result,
					provider: providerId,
					results: assessment.usableResults.map((item) => ({ ...item, provenance: [{ provider: providerId, rank: item.rank }] })),
					attempts,
				};
			}
			batches.push({ provider: providerId, results: assessment.usableResults, downloadedBytes: result.downloadedBytes });
		}

		const usable = batches.filter((batch) => batch.results.length > 0);
		const first = usable[0];
		if (first !== undefined) {
			const { mergeSearchResults } = await import("./merge.js");
			return {
				status: "success",
				provider: first.provider,
				results: mergeSearchResults(usable.map((batch, index) => ({ ...batch, weight: index === 0 ? 1 : 0.9 })), params.limit),
				downloadedBytes: usable.reduce((sum, batch) => sum + batch.downloadedBytes, 0),
				attempts,
			};
		}

		if (userAborted(context)) return failure(abortedFailure(params.query), attempts);
		const allFailed = attempts.length > 0 && attempts.every((attempt) => attempt.status === "failed");
		if (!deadlineExpired(context) && (candidates.length === 0 || allFailed)) {
			const ddg = await this.searchDdg(params, context, attempts);
			if (ddg !== undefined) return ddg;
		}
		return failure(lastFailure ?? noProvider(params.query), attempts);
	}

	private async searchDdg(
		params: NormalizedSearchParams,
		context: SearchProviderContext,
		attempts: WebSearchProviderAttempt[],
	): Promise<SearchRouterResult | undefined> {
		const provider = this.providers.get("duckduckgo_html");
		if (provider === undefined) return undefined;
		const started = context.now();
		const result = await provider.search(params, context);
		const duration = context.now() - started;
		if (result.status === "failed") {
			attempts.push(failedAttempt(result.provider, result.details, duration));
			return failure(result.details, attempts);
		}
		const assessment = assessSearchQuality(result.results, params.compiled, params.limit);
		attempts.push({
			provider: result.provider,
			status: "success",
			duration_ms: duration,
			quality: assessment.quality,
			result_count: assessment.usableResults.length,
		});
		if (assessment.usableResults.length === 0) return undefined;
		return { ...result, results: assessment.usableResults, attempts };
	}
}

function failedAttempt(provider: WebSearchProviderId, details: WebSearchFailureDetails, duration: number): WebSearchProviderAttempt {
	return {
		provider,
		status: "failed",
		duration_ms: duration,
		quality: "hard_failure",
		error: details.error,
		...(details.http_status !== undefined ? { http_status: details.http_status } : {}),
	};
}

function noProvider(query: string): WebSearchFailureDetails {
	return { status: "failed", query, error: { code: "NO_PROVIDER_AVAILABLE", message: "no search provider produced usable results." } };
}

function timeoutFailure(query: string): WebSearchFailureDetails {
	return { status: "failed", query, error: { code: "TIMEOUT", message: "websearch deadline exceeded." } };
}

function abortedFailure(query: string): WebSearchFailureDetails {
	return { status: "failed", query, error: { code: "ABORTED", message: "websearch request was aborted." } };
}

function deadlineExpired(context: SearchProviderContext): boolean {
	return context.deadlineAt !== undefined && context.now() >= context.deadlineAt;
}

function userAborted(context: SearchProviderContext): boolean {
	return context.userSignal?.aborted === true || context.signal?.aborted === true && !deadlineExpired(context);
}

function failure(details: WebSearchFailureDetails, attempts: WebSearchProviderAttempt[]): SearchRouterResult {
	return { status: "failed", details: { ...details, attempts } };
}
