import type { SearchProviderRouter } from "../search-providers/router.js";
import { normalizeSearchParams } from "../search-providers/query.js";
import type { SearchFlights } from "./search-flights.js";
import { searchFlightKey } from "./search-flights.js";
import type { WebSearchExecutionContext, WebSearchFailureDetails, WebSearchParams, WebSearchResult, WebSearchSuccessDetails, WebToolsConfig } from "../core/types.js";
import { escapeXml } from "../network/url-utils.js";

/** 搜索执行层依赖；provider 由 router 隔离，便于测试 fallback 和 singleflight。 */
export interface ExecuteWebSearchRuntime {
	config: WebToolsConfig;
	searches: SearchFlights;
	router: SearchProviderRouter;
	providerSignature?: string;
	context: WebSearchExecutionContext;
	now: () => number;
}

/** 执行公开网页搜索；只返回搜索结果，不抓取结果页面。 */
export async function executeWebSearch(params: WebSearchParams, runtime: ExecuteWebSearchRuntime): Promise<WebSearchResult> {
	const startedAt = runtime.now();
	const normalized = normalizeSearchParams(params, runtime.config.websearch.default_results, {
		includeDomains: runtime.config.websearch.include_domains,
		excludeDomains: runtime.config.websearch.exclude_domains,
	});
	if (normalized.compiled.includeDomains.some((domain) => normalized.compiled.excludeDomains.includes(domain))) {
		const details = { ...invalid("site: and -site: domains must not overlap."), duration_ms: runtime.now() - startedAt };
		return { content: failureContent(details), details };
	}
	const query = normalized.query;
	const limit = normalized.limit;
	const key = searchFlightKey(query, limit, runtime.config.websearch, runtime.providerSignature);
	runtime.context.onUpdate?.({
		content: "Searching...",
		details: { status: "progress", phase: "requesting" },
	});
	const deadlineAt = startedAt + runtime.config.websearch.total_deadline_seconds * 1000;
	const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineAt - runtime.now()));
	const signal = AbortSignal.any([runtime.context.signal ?? new AbortController().signal, deadlineSignal]);
	const routed = await runtime.searches.run(key, () => runtime.router.search(normalized, {
		signal,
		...(runtime.context.signal !== undefined ? { userSignal: runtime.context.signal } : {}),
		now: runtime.now,
		onUpdate: runtime.context.onUpdate,
		deadlineAt,
	}));

	if (routed.status === "failed") {
		const details: WebSearchFailureDetails = {
			...routed.details,
			query,
			duration_ms: runtime.now() - startedAt,
			query_type: normalized.compiled.intent,
		};
		return { content: failureContent(details), details };
	}

	const details: WebSearchSuccessDetails = {
		status: "success",
		query,
		provider: routed.provider,
		results: routed.results,
		downloaded_bytes: routed.downloadedBytes,
		duration_ms: runtime.now() - startedAt,
		attempts: routed.attempts,
		query_type: normalized.compiled.intent,
	};
	return { content: successContent(details), details };
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
