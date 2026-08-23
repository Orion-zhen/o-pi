import { describe, expect, it } from "vitest";

import { normalizeSearchParams } from "../../src/web-tools/search-providers/query.js";
import { SearchProviderRouter } from "../../src/web-tools/search-providers/router.js";
import type { SearchProviderResult, WebSearchProvider } from "../../src/web-tools/search-providers/types.js";
import type { WebSearchErrorCode, WebSearchProviderId } from "../../src/web-tools/core/types.js";

function provider(id: WebSearchProviderId, result: SearchProviderResult, calls: string[]): WebSearchProvider {
	return { id, async search() { calls.push(id); return result; } };
}

function success(id: WebSearchProviderId, count = 3): SearchProviderResult {
	return {
		status: "success",
		provider: id,
		downloadedBytes: 1,
		results: Array.from({ length: count }, (_, index) => ({
			rank: index + 1,
			title: `Pi agent result ${index}`,
			url: `https://site${index}.test/pi-agent`,
			snippet: "Pi agent documentation and useful result snippet.",
		})),
	};
}

function failed(id: WebSearchProviderId, code: WebSearchErrorCode = "TIMEOUT", httpStatus?: number): SearchProviderResult {
	return {
		status: "failed",
		provider: id,
		details: {
			status: "failed",
			provider: id,
			error: { code, message: code },
			query: "pi agent",
			...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
		},
	};
}

function params(query = "pi agent", limit = 3) { return normalizeSearchParams({ query, limit }, 8); }
function context(now = () => 0) { return { now, deadlineAt: 20_000 }; }

describe("adaptive search router", () => {
	it("Brave accepted 时只调用一个正式 provider", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([provider("brave_api", success("brave_api"), calls), provider("tavily", success("tavily"), calls)]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "brave_api" });
		expect(calls).toEqual(["brave_api"]);
	});

	it("Brave partial 后用 Tavily 修复，最多调用两个正式 provider", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([
			provider("brave_api", success("brave_api", 1), calls),
			provider("tavily", success("tavily"), calls),
			provider("exa_api", success("exa_api"), calls),
		]);
		const result = await router.search(params(), context());
		expect(result).toMatchObject({ status: "success", attempts: [{ provider: "brave_api", quality: "partial" }, { provider: "tavily" }] });
		expect(calls).toEqual(["brave_api", "tavily"]);
	});

	it("可用 partial 不调用 DDG，第二 provider 失败时保留第一批结果", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([
			provider("brave_api", success("brave_api", 1), calls),
			provider("tavily", failed("tavily"), calls),
			provider("duckduckgo_html", success("duckduckgo_html"), calls),
		]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "brave_api" });
		expect(calls).toEqual(["brave_api", "tavily"]);
	});

	it("用户取消不 fallback", async () => {
		const calls: string[] = [];
		const controller = new AbortController();
		controller.abort();
		const router = new SearchProviderRouter([
			provider("brave_api", failed("brave_api"), calls),
			provider("tavily", failed("tavily"), calls),
			provider("duckduckgo_html", success("duckduckgo_html"), calls),
		]);
		await expect(router.search(params(), { ...context(), signal: controller.signal, userSignal: controller.signal })).resolves.toMatchObject({ status: "failed" });
		expect(calls).toEqual([]);
	});

	it("两个已尝试正式 provider 都 hard failure 时调用 DDG，即使第三候选未请求", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([
			provider("brave_api", failed("brave_api"), calls),
			provider("tavily", failed("tavily"), calls),
			provider("exa_api", failed("exa_api"), calls),
			provider("duckduckgo_html", success("duckduckgo_html", 1), calls),
		]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "duckduckgo_html" });
		expect(calls).toEqual(["brave_api", "tavily", "duckduckgo_html"]);
	});

	it("没有正式 provider 时直接使用 DDG", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([provider("duckduckgo_html", success("duckduckgo_html", 1), calls)]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "duckduckgo_html" });
		expect(calls).toEqual(["duckduckgo_html"]);
	});

	it("总 deadline 阻止后续 fallback 和 DDG", async () => {
		let now = 0;
		const calls: string[] = [];
		const first: WebSearchProvider = { id: "brave_api", async search() { calls.push("brave_api"); now = 11; return failed("brave_api"); } };
		const router = new SearchProviderRouter([first, provider("tavily", failed("tavily"), calls), provider("duckduckgo_html", success("duckduckgo_html"), calls)]);
		await expect(router.search(params(), { now: () => now, deadlineAt: 10 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "TIMEOUT" } } });
		expect(calls).toEqual(["brave_api"]);
	});

	it("正式 provider 不保留跨调用 cooldown 或 negative cache", async () => {
		const calls: string[] = [];
		let count = 0;
		const providerWithState: WebSearchProvider = {
			id: "brave_api",
			async search() {
				calls.push("brave_api");
				count += 1;
				return count === 1 ? failed("brave_api", "RATE_LIMITED", 429) : success("brave_api");
			},
		};
		const router = new SearchProviderRouter([providerWithState]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "failed" });
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "brave_api" });
		expect(calls).toEqual(["brave_api", "brave_api"]);
	});
});
