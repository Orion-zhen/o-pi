import type { FormalWebSearchProviderId, WebSearchErrorCode, WebSearchFailureDetails, WebSearchProviderAttempt, WebSearchProviderId } from "../core/types.js";
import { assessSearchQuality, type QualityAssessment } from "./quality.js";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.js";

const TERMINAL_ERRORS = new Set<WebSearchErrorCode>(["ABORTED", "INVALID_ARGUMENT"]);

export type SearchRouterResult =
	| {
			status: "success";
			provider: WebSearchProviderId;
			results: SearchProviderResult & { status: "success" };
			attempts: WebSearchProviderAttempt[];
			quality: "accepted" | "partial";
	  }
	| {
			status: "failed";
			details: WebSearchFailureDetails;
			attempts: WebSearchProviderAttempt[];
	  };

/** 按查询意图执行最多两个正式 provider；正式 provider 不保留跨调用健康状态。 */
export class SearchProviderRouter {
	private readonly providers: Map<WebSearchProviderId, WebSearchProvider>;

	constructor(providers: readonly WebSearchProvider[]) {
		this.providers = new Map(providers.map((provider) => [provider.id, provider]));
	}

	async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchRouterResult> {
		const candidates = candidateOrder(primaryFor(params), params).filter((provider) => this.providers.has(provider));
		const attempts: WebSearchProviderAttempt[] = [];
		const formalResults: Array<{ provider: FormalWebSearchProviderId; assessment: QualityAssessment; result: SearchProviderResult & { status: "success" } }> = [];
		let formalProviderCalls = 0;
		let lastFailure: WebSearchFailureDetails | undefined;
		if (deadlineExpired(context)) return failure(timeoutFailure(params.query), attempts);
		if (userAborted(context)) return failure(abortedFailure(params.query), attempts);

		for (const [index, providerId] of candidates.entries()) {
			if (formalProviderCalls >= 2) break;
			if (deadlineExpired(context)) {
				lastFailure = timeoutFailure(params.query);
				break;
			}
			const provider = this.providers.get(providerId);
			if (provider === undefined) continue;
			const started = context.now();
			const result = await provider.search({
				...params,
				lastFormalOpportunity: formalProviderCalls === 1 || index === candidates.length - 1,
			}, context);
			const duration = context.now() - started;
			formalProviderCalls += 1;

			if (result.status === "failed") {
				lastFailure = result.details;
				const terminal = TERMINAL_ERRORS.has(result.details.error.code);
				attempts.push({
					provider: providerId,
					status: "failed",
					duration_ms: duration,
					quality: "hard_failure",
					error: result.details.error,
					...(result.details.http_status !== undefined ? { http_status: result.details.http_status } : {}),
				});
				if (terminal) return failure(result.details, attempts);
				if (userAborted(context)) return failure(abortedFailure(params.query), attempts);
				continue;
			}

			const assessment = assessSearchQuality(result.results, params.compiled, params.limit);
			const usableResult: SearchProviderResult & { status: "success" } = {
				...result,
				results: assessment.usableResults.map((item) => ({ ...item, provenance: [{ provider: providerId, rank: item.rank }] })),
			};
			attempts.push({
				provider: providerId,
				status: "success",
				duration_ms: duration,
				quality: assessment.quality,
				result_count: assessment.usableResults.length,
			});
			formalResults.push({ provider: providerId, assessment, result: usableResult });
			if (assessment.quality === "accepted" && formalResults.length === 1) {
				return success(providerId, usableResult, attempts, "accepted");
			}
			if (formalResults.length === 2) break;
		}

		const usable = formalResults.filter((entry) => entry.assessment.usableResults.length > 0);
		if (usable.length > 0) {
			const { mergeSearchResults } = await import("./merge.js");
			const merged = mergeSearchResults(
				usable.map((entry, index) => ({ provider: entry.provider, weight: index === 0 ? 1 : 0.9, results: entry.assessment.usableResults })),
				params.limit,
			);
			const assessment = assessSearchQuality(merged, params.compiled, params.limit);
			const provider = usable[0]?.provider ?? primaryFor(params);
			const result: SearchProviderResult & { status: "success" } = {
				status: "success",
				provider,
				results: merged,
				downloadedBytes: usable.reduce((sum, entry) => sum + entry.result.downloadedBytes, 0),
			};
			return success(provider, result, attempts, assessment.quality === "soft_miss" ? "partial" : assessment.quality);
		}

		if (userAborted(context)) return failure(abortedFailure(params.query), attempts);
		if (!deadlineExpired(context) && shouldSearchDdg(candidates, formalProviderCalls, attempts)) {
			const ddg = await this.searchDdg(params, context, attempts);
			if (ddg !== undefined) return ddg;
		}
		return failure(lastFailure ?? noProvider(params.query), attempts);
	}

	async close(): Promise<void> {
		await Promise.all([...this.providers.values()].map((provider) => provider.close?.()));
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
			attempts.push({
				provider: result.provider,
				status: "failed",
				duration_ms: duration,
				quality: "hard_failure",
				error: result.details.error,
				...(result.details.http_status !== undefined ? { http_status: result.details.http_status } : {}),
			});
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
		return success(result.provider, { ...result, results: assessment.usableResults }, attempts, "partial");
	}
}

function primaryFor(params: NormalizedSearchParams): FormalWebSearchProviderId {
	return params.compiled.intent === "paper" || params.compiled.intent === "semantic" ? "exa_api" : "brave_api";
}

function candidateOrder(primary: FormalWebSearchProviderId, params: NormalizedSearchParams): FormalWebSearchProviderId[] {
	if (primary === "brave_api") return params.compiled.intent === "paper" || params.compiled.intent === "semantic" ? ["brave_api", "exa_api", "tavily"] : ["brave_api", "tavily", "exa_api"];
	return params.compiled.intent === "exact" || params.compiled.intent === "navigation" ? ["exa_api", "brave_api", "tavily"] : ["exa_api", "tavily", "brave_api"];
}

function shouldSearchDdg(candidates: readonly FormalWebSearchProviderId[], formalProviderCalls: number, attempts: readonly WebSearchProviderAttempt[]): boolean {
	if (candidates.length === 0) return true;
	return formalProviderCalls > 0 && attempts.every((attempt) => attempt.status === "failed" && attempt.quality === "hard_failure");
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
	return { status: "failed", details: { ...details, attempts }, attempts };
}

function success(
	provider: WebSearchProviderId,
	result: SearchProviderResult & { status: "success" },
	attempts: WebSearchProviderAttempt[],
	quality: "accepted" | "partial",
): SearchRouterResult {
	return { status: "success", provider, results: result, attempts, quality };
}
