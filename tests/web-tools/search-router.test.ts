import { describe, expect, it } from "vitest";

import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { normalizeSearchParams } from "../../src/web-tools/search-providers/query.js";
import { SearchProviderRouter } from "../../src/web-tools/search-providers/router.js";
import type { SearchProviderResult, WebSearchProvider } from "../../src/web-tools/search-providers/types.js";
import type { WebSearchErrorCode, WebSearchProviderId } from "../../src/web-tools/types.js";

function provider(id: WebSearchProviderId, result: SearchProviderResult, calls: string[], configured = true): WebSearchProvider {
	return { id, configured: () => configured, async search() { calls.push(id); return result; } };
}

function success(id: WebSearchProviderId, count = 3): SearchProviderResult {
	return { status: "success", provider: id, downloadedBytes: 1, results: Array.from({ length: count }, (_, index) => ({ rank: index + 1, title: `Pi agent result ${index}`, url: `https://site${index}.test/pi-agent`, snippet: "Pi agent documentation and useful result snippet." })) };
}

function failed(id: WebSearchProviderId, code: WebSearchErrorCode = "TIMEOUT", httpStatus?: number): SearchProviderResult {
	return { status: "failed", provider: id, details: { status: "failed", provider: id, error: { code, message: code }, query: "pi agent", ...(httpStatus !== undefined ? { http_status: httpStatus } : {}) } };
}

function params(query = "pi agent", limit = 3) { return normalizeSearchParams({ query, limit }, 8); }
function context(now = () => 0) { return { now, deadlineAt: 20_000 }; }

describe("adaptive search router", () => {
	it("Brave accepted 时只调用一个正式 provider", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([provider("brave_api", success("brave_api"), calls), provider("tavily", success("tavily"), calls)], defaultWebToolsConfig().websearch);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "brave_api", formalProviderCalls: 1 });
		expect(calls).toEqual(["brave_api"]);
	});

	it("Brave partial 后用 Tavily 修复、合并且最多调用两个正式 provider", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([provider("brave_api", success("brave_api", 1), calls), provider("tavily", success("tavily"), calls), provider("exa_api", success("exa_api"), calls)], defaultWebToolsConfig().websearch);
		const result = await router.search(params(), context());
		expect(result).toMatchObject({ status: "success", formalProviderCalls: 2, attempts: [{ provider: "brave_api", quality: "partial" }, { provider: "tavily" }] });
		expect(calls).toEqual(["brave_api", "tavily"]);
	});

	it("abort 不 fallback；第二 provider 失败时保留第一批 partial", async () => {
		let calls: string[] = [];
		let router = new SearchProviderRouter([provider("brave_api", failed("brave_api", "ABORTED"), calls), provider("tavily", success("tavily"), calls)], defaultWebToolsConfig().websearch);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "failed", details: { error: { code: "ABORTED" } }, formalProviderCalls: 1 });
		expect(calls).toEqual(["brave_api"]);

		calls = [];
		router = new SearchProviderRouter([provider("brave_api", success("brave_api", 1), calls), provider("tavily", failed("tavily"), calls)], defaultWebToolsConfig().websearch);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", results: { results: [{ title: "Pi agent result 0" }] }, formalProviderCalls: 2 });
	});

	it("三家正式 provider 均 hard failure 或不可用时才调用 DDG", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([
			provider("brave_api", failed("brave_api"), calls),
			provider("tavily", failed("tavily"), calls),
			provider("exa_api", success("exa_api"), calls, false),
			provider("duckduckgo_html", success("duckduckgo_html", 1), calls),
		], defaultWebToolsConfig().websearch);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "duckduckgo_html", formalProviderCalls: 2 });
		expect(calls).toEqual(["brave_api", "tavily", "duckduckgo_html"]);
	});

	it("429 cooldown、额度耗尽和新 router 配置恢复", async () => {
		let now = 0;
		const calls: string[] = [];
		const config = defaultWebToolsConfig().websearch;
		const rateLimited = failed("brave_api", "RATE_LIMITED", 429);
		if (rateLimited.status === "failed") rateLimited.details.retry_after_ms = 1000;
		const router = new SearchProviderRouter([provider("brave_api", rateLimited, calls), provider("tavily", failed("tavily", "QUOTA_EXHAUSTED", 402), calls)], config);
		await router.search(params(), context(() => now));
		expect(router.getHealth("brave_api", now)).toBe("cooldown");
		expect(router.getHealth("tavily", now)).toBe("exhausted");
		now = 1001;
		expect(router.getHealth("brave_api", now)).toBe("degraded");
		const restored = new SearchProviderRouter([provider("brave_api", success("brave_api"), calls)], { ...config, brave_api: { ...config.brave_api, endpoint: "https://example.com/search" } });
		expect(restored.getHealth("brave_api", now)).toBe("healthy");
	});

	it("总 deadline 阻止后续 fallback，并保留已有 partial", async () => {
		let now = 0;
		const calls: string[] = [];
		const first: WebSearchProvider = { id: "brave_api", async search() { calls.push("brave_api"); now = 11; return success("brave_api", 1); } };
		const router = new SearchProviderRouter([first, provider("tavily", success("tavily"), calls)], defaultWebToolsConfig().websearch);
		await expect(router.search(params(), { now: () => now, deadlineAt: 10 })).resolves.toMatchObject({ status: "success", formalProviderCalls: 1, results: { results: [{ title: "Pi agent result 0" }] } });
		expect(calls).toEqual(["brave_api"]);
	});
});
