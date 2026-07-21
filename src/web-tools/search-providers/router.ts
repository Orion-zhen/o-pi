import type { FormalWebSearchProviderId, WebSearchFailureDetails, WebSearchProviderAttempt, WebSearchProviderId, WebToolsConfig } from "../types.js";
import { assessSearchQuality, type QualityAssessment } from "./quality.js";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.js";

const FORMAL_PROVIDERS: readonly FormalWebSearchProviderId[] = ["brave_api", "exa_api", "tavily"];
const TERMINAL_ERRORS = new Set(["ABORTED", "INVALID_ARGUMENT", "CONFIG_ERROR"]);

export type ProviderHealthStatus = "healthy" | "degraded" | "cooldown" | "exhausted" | "misconfigured";

interface ProviderHealth {
	status: ProviderHealthStatus;
	until?: number;
	source?: "missing" | "response";
}

interface NegativeEntry {
	expiresAt: number;
	result: SearchProviderResult;
}

export type SearchRouterResult =
	| {
		status: "success";
		provider: WebSearchProviderId;
		results: SearchProviderResult & { status: "success" };
		attempts: WebSearchProviderAttempt[];
		primaryProvider: FormalWebSearchProviderId;
		quality: "accepted" | "partial";
		formalProviderCalls: number;
		secondaryNewResults: number;
	  }
	| {
		status: "failed";
		details: WebSearchFailureDetails;
		attempts: WebSearchProviderAttempt[];
		primaryProvider: FormalWebSearchProviderId;
		formalProviderCalls: number;
	  };

export class SearchProviderRouter {
	private readonly providers: Map<WebSearchProviderId, WebSearchProvider>;
	private readonly health = new Map<FormalWebSearchProviderId, ProviderHealth>();
	private readonly negative = new Map<string, NegativeEntry>();

	constructor(providers: readonly WebSearchProvider[], private readonly config: WebToolsConfig["websearch"]) {
		this.providers = new Map(providers.map((provider) => [provider.id, provider]));
	}

	async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchRouterResult> {
		const primaryProvider = primaryFor(params);
		const attempts: WebSearchProviderAttempt[] = [];
		const hardFailed = new Set<FormalWebSearchProviderId>();
		const formalResults: Array<{ provider: FormalWebSearchProviderId; assessment: QualityAssessment; result: SearchProviderResult & { status: "success" } }> = [];
		let formalProviderCalls = 0;
		let lastFailure: WebSearchFailureDetails | undefined;
		let fallbackReason: string | undefined;
		const candidates = candidateOrder(primaryProvider, params);

		for (const providerId of candidates) {
			if (formalProviderCalls >= 2) break;
			if (deadlineExpired(context)) { lastFailure = timeoutFailure(params.query); break; }
			const unavailable = this.unavailableReason(providerId, context.now());
			if (unavailable !== undefined) {
				attempts.push(skippedAttempt(providerId, unavailable));
				fallbackReason ??= unavailable;
				continue;
			}
			const provider = this.providers.get(providerId);
			if (provider === undefined || provider.configured?.() === false) {
				this.health.set(providerId, { status: "misconfigured", source: "missing" });
				attempts.push(skippedAttempt(providerId, "provider is not configured"));
				fallbackReason ??= "provider_unavailable";
				continue;
			}
			const cached = this.negative.get(negativeKey(providerId, params));
			if (cached !== undefined && cached.expiresAt > context.now()) {
				attempts.push({ provider: providerId, status: "skipped", cached: true, quality: cached.result.status === "failed" ? "hard_failure" : "soft_miss", error: { code: "NO_PROVIDER_AVAILABLE", message: "negative cache hit" } });
				if (cached.result.status === "failed") hardFailed.add(providerId);
				fallbackReason ??= "negative_cache";
				continue;
			}
			const started = context.now();
			const lastFormalOpportunity = formalProviderCalls === 1 || FORMAL_PROVIDERS.every((id) => id === providerId || hardFailed.has(id) || this.providers.get(id) === undefined || this.providers.get(id)?.configured?.() === false || this.unavailableReason(id, context.now()) !== undefined);
			const result = await provider.search({ ...params, lastFormalOpportunity }, context);
			const duration = context.now() - started;
			if (result.status === "skipped") {
				this.health.set(providerId, { status: "misconfigured", source: "missing" });
				attempts.push(skippedAttempt(providerId, result.reason, duration));
				fallbackReason ??= result.reason;
				continue;
			}
			formalProviderCalls += 1;
			if (result.status === "failed") {
				lastFailure = result.details;
				const terminal = TERMINAL_ERRORS.has(result.details.error.code);
				if (result.details.error.code !== "ABORTED" && result.details.error.code !== "INVALID_ARGUMENT") this.recordFailure(providerId, result.details, context.now());
				if (!terminal) {
					hardFailed.add(providerId);
					this.rememberNegative(providerId, params, result, context.now(), result.details.retry_after_ms);
				}
				attempts.push({ provider: providerId, status: "failed", duration_ms: duration, quality: "hard_failure", error: result.details.error, ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}), ...(result.details.http_status !== undefined ? { http_status: result.details.http_status } : {}) });
				if (terminal) return failure(result.details, attempts, primaryProvider, formalProviderCalls);
				fallbackReason = result.details.error.code;
				continue;
			}

			this.health.set(providerId, { status: "healthy" });
			const assessment = assessSearchQuality(result.results, params.compiled, params.limit);
			const usableResult: SearchProviderResult & { status: "success" } = { ...result, results: assessment.usableResults.map((item) => ({ ...item, provenance: [{ provider: providerId, rank: item.rank }] })) };
			if (assessment.quality === "soft_miss") this.rememberNegative(providerId, params, result, context.now());
			attempts.push({ provider: providerId, status: "success", duration_ms: duration, quality: assessment.quality, result_count: assessment.usableResults.length, ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}) });
			formalResults.push({ provider: providerId, assessment, result: usableResult });
			if (assessment.quality === "accepted" && formalResults.length === 1) {
				return success(providerId, usableResult, attempts, primaryProvider, "accepted", formalProviderCalls, 0);
			}
			fallbackReason ??= assessment.reasons.join(",") || "primary_miss";
			if (formalResults.length === 2) break;
		}

		const usable = formalResults.filter((entry) => entry.assessment.usableResults.length > 0);
		if (usable.length > 0) {
			const { mergeSearchResults } = await import("./merge.js");
			const firstCount = usable[0]?.assessment.usableResults.length ?? 0;
			const merged = mergeSearchResults(usable.map((entry, index) => ({ provider: entry.provider, weight: index === 0 ? 1 : 0.9, results: entry.assessment.usableResults })), params.limit);
			const assessment = assessSearchQuality(merged, params.compiled, params.limit);
			const provider = usable[0]?.provider ?? primaryProvider;
			const result: SearchProviderResult & { status: "success" } = { status: "success", provider, results: merged, downloadedBytes: usable.reduce((sum, entry) => sum + entry.result.downloadedBytes, 0) };
			return success(provider, result, attempts, primaryProvider, assessment.quality === "soft_miss" ? "partial" : assessment.quality, formalProviderCalls, Math.max(0, merged.length - firstCount));
		}

		if (!deadlineExpired(context) && this.allFormalUnavailable(hardFailed, context.now())) {
			const ddg = await this.searchDdg(params, context, attempts);
			if (ddg !== undefined) return { ...ddg, primaryProvider, formalProviderCalls, secondaryNewResults: 0 };
		}
		return failure(lastFailure ?? noProvider(params.query), attempts, primaryProvider, formalProviderCalls);
	}

	getHealth(provider: FormalWebSearchProviderId, now: number): ProviderHealthStatus {
		return this.unavailableReason(provider, now) === undefined ? this.health.get(provider)?.status ?? "healthy" : this.health.get(provider)?.status ?? "misconfigured";
	}

	async close(): Promise<void> { await Promise.all([...this.providers.values()].map((provider) => provider.close?.())); }

	private unavailableReason(provider: FormalWebSearchProviderId, now: number): string | undefined {
		const state = this.health.get(provider);
		if (state === undefined || state.status === "healthy" || state.status === "degraded") return undefined;
		if (state.status === "misconfigured" && state.source === "missing" && this.providers.get(provider)?.configured?.() === true) { this.health.set(provider, { status: "healthy" }); return undefined; }
		if (state.status === "cooldown" && state.until !== undefined && state.until <= now) { this.health.set(provider, { status: "degraded" }); return undefined; }
		return `provider ${state.status}`;
	}

	private recordFailure(provider: FormalWebSearchProviderId, details: WebSearchFailureDetails, now: number): void {
		if (details.http_status === 401 || details.http_status === 403 || details.error.code === "CONFIG_ERROR") this.health.set(provider, { status: "misconfigured", source: "response" });
		else if (details.http_status === 402 || details.error.code === "QUOTA_EXHAUSTED") this.health.set(provider, { status: "exhausted" });
		else if (details.http_status === 429 || details.error.code === "RATE_LIMITED") this.health.set(provider, { status: "cooldown", until: now + (details.retry_after_ms ?? 30_000) });
		else this.health.set(provider, { status: "degraded" });
	}

	private rememberNegative(provider: FormalWebSearchProviderId, params: NormalizedSearchParams, result: SearchProviderResult, now: number, ttlMs?: number): void {
		for (const [key, entry] of this.negative) if (entry.expiresAt <= now) this.negative.delete(key);
		this.negative.set(negativeKey(provider, params), { result, expiresAt: now + (ttlMs ?? this.config.negative_cache_ttl_seconds * 1000) });
		while (this.negative.size > 128) { const oldest = this.negative.keys().next().value; if (oldest === undefined) break; this.negative.delete(oldest); }
	}

	private allFormalUnavailable(hardFailed: ReadonlySet<FormalWebSearchProviderId>, now: number): boolean {
		return FORMAL_PROVIDERS.every((id) => hardFailed.has(id) || this.providers.get(id)?.configured?.() === false || this.providers.get(id) === undefined || this.unavailableReason(id, now) !== undefined);
	}

	private async searchDdg(params: NormalizedSearchParams, context: SearchProviderContext, attempts: WebSearchProviderAttempt[]): Promise<(SearchRouterResult & { status: "success" }) | undefined> {
		const provider = this.providers.get("duckduckgo_html");
		if (provider === undefined || provider.configured?.() === false) return undefined;
		const started = context.now();
		const result = await provider.search(params, context);
		const duration = context.now() - started;
		if (result.status === "success" && result.results.length > 0) {
			const usableResults = assessSearchQuality(result.results, params.compiled, params.limit).usableResults;
			if (usableResults.length === 0) return undefined;
			const filtered = { ...result, results: usableResults };
			attempts.push({ provider: result.provider, status: "success", duration_ms: duration, quality: "partial", result_count: usableResults.length, fallback_reason: "all_formal_providers_unavailable" });
			return { status: "success", provider: result.provider, results: filtered, attempts, primaryProvider: "brave_api", quality: "partial", formalProviderCalls: 0, secondaryNewResults: 0 };
		}
		if (result.status === "failed") attempts.push({ provider: result.provider, status: "failed", duration_ms: duration, quality: "hard_failure", error: result.details.error });
		return undefined;
	}
}

function primaryFor(params: NormalizedSearchParams): FormalWebSearchProviderId { return params.compiled.intent === "paper" || params.compiled.intent === "semantic" ? "exa_api" : "brave_api"; }

function candidateOrder(primary: FormalWebSearchProviderId, params: NormalizedSearchParams): FormalWebSearchProviderId[] {
	if (primary === "brave_api") return params.compiled.intent === "paper" || params.compiled.intent === "semantic" ? ["brave_api", "exa_api", "tavily"] : ["brave_api", "tavily", "exa_api"];
	return params.compiled.intent === "exact" || params.compiled.intent === "navigation" ? ["exa_api", "brave_api", "tavily"] : ["exa_api", "tavily", "brave_api"];
}

function negativeKey(provider: FormalWebSearchProviderId, params: NormalizedSearchParams): string { return `${provider}\0${params.query.toLowerCase()}\0${JSON.stringify([params.includeDomains, params.excludeDomains])}`; }
function skippedAttempt(provider: WebSearchProviderId, message: string, duration_ms?: number): WebSearchProviderAttempt { return { provider, status: "skipped", ...(duration_ms !== undefined ? { duration_ms } : {}), error: { code: "NO_PROVIDER_AVAILABLE", message } }; }
function noProvider(query: string): WebSearchFailureDetails { return { status: "failed", query, error: { code: "NO_PROVIDER_AVAILABLE", message: "no search provider produced usable results." } }; }
function timeoutFailure(query: string): WebSearchFailureDetails { return { status: "failed", query, error: { code: "TIMEOUT", message: "websearch deadline exceeded." } }; }
function deadlineExpired(context: SearchProviderContext): boolean { return context.deadlineAt !== undefined && context.now() >= context.deadlineAt; }
function failure(details: WebSearchFailureDetails, attempts: WebSearchProviderAttempt[], primaryProvider: FormalWebSearchProviderId, formalProviderCalls: number): SearchRouterResult { return { status: "failed", details: { ...details, attempts }, attempts, primaryProvider, formalProviderCalls }; }
function success(provider: WebSearchProviderId, result: SearchProviderResult & { status: "success" }, attempts: WebSearchProviderAttempt[], primaryProvider: FormalWebSearchProviderId, quality: "accepted" | "partial", formalProviderCalls: number, secondaryNewResults: number): SearchRouterResult { return { status: "success", provider, results: result, attempts, primaryProvider, quality, formalProviderCalls, secondaryNewResults }; }
