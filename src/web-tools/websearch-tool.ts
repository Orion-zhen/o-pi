import type { SearchProviderRouter } from "./search-providers/router.js";
import { normalizeSearchParams } from "./search-providers/query.js";
import type { SearchCache } from "./search-cache.js";
import { searchCacheKey } from "./search-cache.js";
import type { SearchCorpus } from "./search-corpus.js";
import type { WebSearchExecutionContext, WebSearchFailureDetails, WebSearchParams, WebSearchResult, WebSearchSuccessDetails, WebToolsConfig } from "./types.js";
import { escapeXml } from "./url-utils.js";

/** 搜索执行层依赖；provider 由 router 隔离，便于测试 fallback 和缓存。 */
export interface ExecuteWebSearchRuntime {
	config: WebToolsConfig;
	searches: SearchCache;
	router: SearchProviderRouter;
	providerSignature?: string;
	context: WebSearchExecutionContext;
	now: () => number;
	corpus?: SearchCorpus;
}

/** 执行公开网页搜索；只返回搜索结果，不抓取结果页面。 */
export async function executeWebSearch(params: WebSearchParams, runtime: ExecuteWebSearchRuntime): Promise<WebSearchResult> {
	const startedAt = runtime.now();
	const validation = validateParams(params);
	if (validation !== undefined) return { content: failureContent(validation), details: { ...validation, duration_ms: runtime.now() - startedAt } };

	const normalized = normalizeSearchParams(params, runtime.config.websearch.default_results, {
		includeDomains: runtime.config.websearch.include_domains,
		excludeDomains: runtime.config.websearch.exclude_domains,
	});
	if (normalized.includeDomains.some((domain) => normalized.excludeDomains.includes(domain))) {
		const details = { ...invalid("site: and -site: domains must not overlap."), duration_ms: runtime.now() - startedAt };
		return { content: failureContent(details), details };
	}
	const query = normalized.query;
	const limit = normalized.limit;
	const approximateReformulation = runtime.corpus?.recordQuery(normalized) ?? false;
	const corpusUsage = runtime.corpus?.usage();
	const key = searchCacheKey(query, limit, runtime.config.websearch, runtime.providerSignature);
	const cached = runtime.searches.get(key);
	if (cached !== undefined) {
		const details: WebSearchSuccessDetails = {
			status: "success",
			query,
			provider: cached.provider,
			results: cached.results,
			cached: true,
			downloaded_bytes: cached.downloadedBytes,
			duration_ms: runtime.now() - startedAt,
			attempts: [{ provider: cached.provider, status: "success", cached: true }],
			reused: "cache",
			approximate_reformulation: approximateReformulation,
			...(corpusUsage === undefined ? {} : { corpus_discovered: corpusUsage.discovered, corpus_fetched: corpusUsage.fetched, corpus_cited: corpusUsage.cited }),
		};
		return { content: successContent(details), details };
	}
	const corpusResults = runtime.corpus?.find(normalized);
	if (corpusResults !== undefined) {
		const provider = corpusResults[0]?.provenance?.[0]?.provider ?? "brave_api";
		const details: WebSearchSuccessDetails = { status: "success", query, provider, results: corpusResults, cached: true, downloaded_bytes: 0, duration_ms: runtime.now() - startedAt, attempts: [{ provider, status: "success", cached: true }], reused: "corpus", formal_provider_calls: 0, approximate_reformulation: approximateReformulation, ...(corpusUsage === undefined ? {} : { corpus_discovered: corpusUsage.discovered, corpus_fetched: corpusUsage.fetched, corpus_cited: corpusUsage.cited }) };
		return { content: successContent(details), details };
	}

	runtime.context.onUpdate?.({
		content: "Searching...",
		details: { status: "progress", phase: "requesting" },
	});
	const deadlineAt = startedAt + runtime.config.websearch.total_deadline_seconds * 1000;
	const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineAt - runtime.now()));
	const signal = AbortSignal.any([runtime.context.signal ?? new AbortController().signal, deadlineSignal]);
	const routed = await runtime.searches.runSingleflight(key, () => runtime.router.search(normalized, {
		signal,
		...(runtime.context.signal !== undefined ? { userSignal: runtime.context.signal } : {}),
		now: runtime.now,
		onUpdate: runtime.context.onUpdate,
		deadlineAt,
	}));

	if (routed.status === "failed") {
		const fallbackReason = routed.attempts.find((attempt) => attempt.fallback_reason !== undefined)?.fallback_reason;
		const details = {
			...routed.details,
			query,
			duration_ms: runtime.now() - startedAt,
			primary_provider: routed.primaryProvider,
			query_type: normalized.compiled.intent,
			formal_provider_calls: routed.formalProviderCalls,
			first_call_accepted: false,
			...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
			provider_latencies: routed.attempts.flatMap((attempt) => attempt.duration_ms === undefined ? [] : [`${attempt.provider}:${attempt.duration_ms}`]),
			provider_errors: routed.attempts.flatMap((attempt) => attempt.error === undefined ? [] : [`${attempt.provider}:${attempt.error.code}`]),
			approximate_reformulation: approximateReformulation,
		};
		return { content: failureContent(details), details };
	}

	const fallbackReason = routed.attempts.find((attempt) => attempt.fallback_reason !== undefined)?.fallback_reason;
	const details: WebSearchSuccessDetails = {
		status: "success",
		query,
		provider: routed.provider,
		results: routed.results.results,
		cached: false,
		downloaded_bytes: routed.results.downloadedBytes,
		duration_ms: runtime.now() - startedAt,
		attempts: routed.attempts,
		primary_provider: routed.primaryProvider,
		query_type: normalized.compiled.intent,
		formal_provider_calls: routed.formalProviderCalls,
		secondary_new_results: routed.secondaryNewResults,
		first_call_accepted: routed.attempts.find((attempt) => attempt.status !== "skipped")?.quality === "accepted",
		...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
		provider_latencies: routed.attempts.flatMap((attempt) => attempt.duration_ms === undefined ? [] : [`${attempt.provider}:${attempt.duration_ms}`]),
		provider_errors: routed.attempts.flatMap((attempt) => attempt.error === undefined ? [] : [`${attempt.provider}:${attempt.error.code}`]),
		approximate_reformulation: approximateReformulation,
		...(corpusUsage === undefined ? {} : { corpus_discovered: corpusUsage.discovered, corpus_fetched: corpusUsage.fetched, corpus_cited: corpusUsage.cited }),
	};
	runtime.searches.set({
		key,
		createdAt: runtime.now(),
		provider: routed.provider,
		results: routed.results.results,
		downloadedBytes: routed.results.downloadedBytes,
	});
	if (routed.quality === "accepted") {
		const providers = [...new Set(routed.results.results.flatMap((item) => item.provenance?.map((entry) => entry.provider) ?? []))];
		runtime.corpus?.add(normalized, routed.results.results, providers);
	}
	return { content: successContent(details), details };
}

function validateParams(params: WebSearchParams): WebSearchFailureDetails | undefined {
	if (!isRecord(params)) {
		return invalid("params must be an object.");
	}
	if (typeof params.query !== "string") {
		return invalid("query must be a string.");
	}
	const query = params.query.trim();
	if (query.length < 1 || query.length > 512) {
		return invalid("query length must be between 1 and 512 characters.");
	}
	if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 20)) {
		return invalid("limit must be an integer between 1 and 20.");
	}
	return undefined;
}

function invalid(message: string): WebSearchFailureDetails {
	return {
		status: "failed",
		error: { code: "INVALID_ARGUMENT", message },
	};
}

function successContent(details: WebSearchSuccessDetails): string {
	const attrs = [
		`query="${escapeXml(details.query)}"`,
		`count="${details.results.length}"`,
		`provider="${escapeXml(details.provider)}"`,
		`trust="untrusted"`,
	].join(" ");
	const body = details.results
		.map((item) => {
			const lines = [
				`[${item.rank}] ${escapeXml(truncateChars(item.title, 160))}`,
				`URL: ${escapeXml(item.url)}`,
				item.snippet ? `Snippet: ${escapeXml(truncateChars(item.snippet, 240))}` : undefined,
			].filter((line): line is string => line !== undefined);
			return lines.join("\n");
		})
		.join("\n\n");
	return `<websearch_results ${attrs}>\n${body}\n</websearch_results>`;
}

function failureContent(details: WebSearchFailureDetails): string {
	return `<error tool="websearch" code="${escapeXml(details.error.code)}">
${escapeXml(details.error.message)}
</error>`;
}

function truncateChars(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
