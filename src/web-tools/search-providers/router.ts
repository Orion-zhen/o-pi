import type { WebSearchFailureDetails, WebSearchProviderAttempt, WebSearchProviderId, WebToolsConfig } from "../types.js";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.js";

/** Router 执行结果；成功保留命中的 provider，失败保留完整 attempts 诊断。 */
export type SearchRouterResult =
	| {
			status: "success";
			provider: WebSearchProviderId;
			results: SearchProviderResult & { status: "success" };
			attempts: WebSearchProviderAttempt[];
	  }
	| {
			status: "failed";
			details: WebSearchFailureDetails;
			attempts: WebSearchProviderAttempt[];
	  };

/** 按配置顺序执行 provider；provider 选择是运行时策略，不进入工具 schema。 */
export class SearchProviderRouter {
	private readonly providers: Map<WebSearchProviderId, WebSearchProvider>;

	constructor(
		providers: readonly WebSearchProvider[],
		private readonly config: WebToolsConfig["websearch"],
	) {
		this.providers = new Map(providers.map((provider) => [provider.id, provider]));
	}

	async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchRouterResult> {
		const attempts: WebSearchProviderAttempt[] = [];
		let lastFailure: WebSearchFailureDetails | undefined;
		for (const providerId of providerOrder(this.config.provider_order)) {
			const provider = this.providers.get(providerId);
			if (provider === undefined) {
				attempts.push({
					provider: providerId,
					status: "skipped",
					error: { code: "CONFIG_ERROR", message: "provider is not configured." },
				});
				continue;
			}
			const startedAt = context.now();
			const result = await provider.search(params, context);
			const duration = context.now() - startedAt;
			if (result.status === "skipped") {
				attempts.push({
					provider: result.provider,
					status: "skipped",
					duration_ms: duration,
					error: { code: "NO_PROVIDER_AVAILABLE", message: result.reason },
				});
				continue;
			}
			if (result.status === "success") {
				attempts.push({ provider: result.provider, status: "success", duration_ms: duration });
				return { status: "success", provider: result.provider, results: result, attempts };
			}
			lastFailure = result.details;
			attempts.push({
				provider: result.provider,
				status: "failed",
				duration_ms: duration,
				error: result.details.error,
				...(result.details.http_status !== undefined ? { http_status: result.details.http_status } : {}),
			});
			if (!this.config.fallback) {
				return { status: "failed", details: { ...result.details, attempts }, attempts };
			}
		}

		const fallbackFailure: WebSearchFailureDetails = lastFailure ?? {
			status: "failed",
			error: { code: "NO_PROVIDER_AVAILABLE", message: "no enabled search provider is available." },
			query: params.query,
		};
		return { status: "failed", details: { ...fallbackFailure, attempts }, attempts };
	}

	async close(): Promise<void> {
		await Promise.all([...this.providers.values()].map((provider) => provider.close?.()));
	}
}

function providerOrder(order: readonly WebSearchProviderId[]): WebSearchProviderId[] {
	return [...new Set(order)];
}
