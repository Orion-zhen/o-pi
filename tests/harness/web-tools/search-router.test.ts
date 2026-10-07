import { describe, expect, it } from "vitest";

import { normalizeSearchParams } from "../../../src/harness/web-tools/search-providers/query.ts";
import { SearchProviderRouter } from "../../../src/harness/web-tools/search-providers/router.ts";
import type { SearchProviderResult, WebSearchProvider } from "../../../src/harness/web-tools/search-providers/types.ts";
import type { WebSearchErrorCode, WebSearchProviderId } from "../../../src/harness/web-tools/core/types.ts";

function provider(id: WebSearchProviderId, result: SearchProviderResult, calls: string[]): WebSearchProvider {
	return { id, async search() { calls.push(id); return result; } };
}

function success(id: WebSearchProviderId, count = 3): SearchProviderResult {
	return {
		status: "success", provider: id, downloadedBytes: 1,
		results: Array.from({ length: count }, (_, index) => ({
			rank: index + 1, title: `Result ${index}`, url: `https://example.com/page/${index}`,
		})),
	};
}

function failed(id: WebSearchProviderId, code: WebSearchErrorCode = "TIMEOUT", httpStatus?: number): SearchProviderResult {
	return {
		status: "failed", provider: id,
		details: {
			status: "failed", provider: id, error: { code, message: code }, query: "pi agent",
			...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
		},
	};
}

function params(query = "pi agent", limit = 3) { return normalizeSearchParams({ query, limit }, 8); }
function context(now = () => 0) { return { now, deadlineAt: 20_000 }; }

const ORDER = ["brave_api", "exa_api", "tavily", "duckduckgo_html"] as const;

describe("串行搜索", () => {
	it.each([
		"pi agent",
		"research papers about sparse mixture of experts routing",
		"find practical approaches that compare several subtle tradeoffs across distributed teams and systems",
		"如何查找相关研究论文",
	])("查询不改变首选，少量无摘要结果也直接返回：%s", async (query) => {
		const calls: string[] = [];
		const router = new SearchProviderRouter(ORDER.map((id) => provider(id, success(id, 1), calls)));
		await expect(router.search(params(query), context())).resolves.toMatchObject({
			status: "success", provider: "brave_api",
			attempts: [{ provider: "brave_api", status: "success", result_count: 1 }],
		});
		expect(calls).toEqual(["brave_api"]);
	});

	it.each(["failed", "empty"] as const)("前序 %s 时按 Brave、Exa、Tavily、DDG 继续", async (outcome) => {
		const calls: string[] = [];
		const router = new SearchProviderRouter(ORDER.map((id) => provider(id,
			id === "duckduckgo_html" ? success(id, 1) : outcome === "failed" ? failed(id) : success(id, 0), calls)));
		const result = await router.search(params(), context());
		expect(result).toMatchObject({ status: "success", provider: "duckduckgo_html" });
		expect(calls).toEqual(ORDER);
	});

	it("使用传入顺序，不按引擎名称重新排序", async () => {
		const calls: string[] = [];
		const order = [...ORDER].reverse();
		const router = new SearchProviderRouter(order.map((id) => provider(id, success(id, 0), calls)));
		await router.search(params(), context());
		expect(calls).toEqual(order);
	});

	it.each(ORDER)("%s 是唯一可用提供方时直接调用", async (id) => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([provider(id, success(id, 1), calls)]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: id });
		expect(calls).toEqual([id]);
	});

	it("第一家为空，第二家有结果时立即返回，不合并或限制同域数量", async () => {
		const calls: string[] = [];
		const batch = success("exa_api", 4);
		const router = new SearchProviderRouter(ORDER.map((id) => provider(id,
			id === "brave_api" ? success(id, 0) : id === "exa_api" ? batch : success(id), calls)));
		const result = await router.search(params("site:example.com pi docs", 4), context());
		expect(result).toMatchObject({ status: "success", provider: "exa_api", attempts: [
			{ provider: "brave_api", result_count: 0 }, { provider: "exa_api", result_count: 4 },
		] });
		if (result.status !== "success" || batch.status !== "success") throw new Error("expected results");
		expect(result.results).toEqual(batch.results);
		expect(calls).toEqual(["brave_api", "exa_api"]);
	});

	it("域名过滤先于 limit，保留子域结果的相对顺序", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([provider("brave_api", {
			status: "success", provider: "brave_api", downloadedBytes: 1,
			results: ["notexample.com", "blocked.example.com", "docs.example.com", "example.com"].map((host, index) => ({
				rank: index + 1, title: host, url: `https://${host}/`,
			})),
		}, calls)]);
		const result = await router.search(params("site:example.com -site:blocked.example.com text", 2), context());
		expect(result).toMatchObject({ status: "success", results: [
			{ rank: 1, url: "https://docs.example.com/" }, { rank: 2, url: "https://example.com/" },
		] });
	});

	it("第一家全部被域名约束排除时继续下一家", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([
			provider("brave_api", success("brave_api"), calls),
			provider("exa_api", { status: "success", provider: "exa_api", downloadedBytes: 1,
				results: [{ rank: 1, title: "Other", url: "https://allowed.test/" }] }, calls),
		]);
		await expect(router.search(params("site:allowed.test text"), context())).resolves.toMatchObject({ status: "success", provider: "exa_api" });
		expect(calls).toEqual(["brave_api", "exa_api"]);
	});

	it.each(["INVALID_ARGUMENT", "CONFIG_ERROR", "RATE_LIMITED", "QUOTA_EXHAUSTED"] as const)("提供方返回 %s 时仍可尝试下一家", async (code) => {
		const calls: string[] = [];
		const router = new SearchProviderRouter([
			provider("brave_api", failed("brave_api", code), calls), provider("exa_api", success("exa_api"), calls),
		]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "exa_api" });
		expect(calls).toEqual(["brave_api", "exa_api"]);
	});

	it("没有提供方或所有提供方都为空时返回明确失败", async () => {
		for (const providers of [[], ORDER.map((id) => provider(id, success(id, 0), []))]) {
			await expect(new SearchProviderRouter(providers).search(params(), context())).resolves.toMatchObject({
				status: "failed", details: { error: { code: "NO_PROVIDER_AVAILABLE" } },
			});
		}
	});

	it("全部请求失败时保留最后错误和完整尝试记录", async () => {
		const calls: string[] = [];
		const router = new SearchProviderRouter(ORDER.map((id) => provider(id, failed(id, "HTTP_ERROR", 503), calls)));
		const result = await router.search(params(), context());
		expect(result).toMatchObject({ status: "failed", details: {
			provider: "duckduckgo_html", error: { code: "HTTP_ERROR" },
			attempts: ORDER.map((id) => ({ provider: id, status: "failed", http_status: 503 })),
		} });
		expect(calls).toEqual(ORDER);
	});

	it("已取消的请求不调用提供方", async () => {
		const calls: string[] = [];
		const signal = AbortSignal.abort();
		const router = new SearchProviderRouter(ORDER.map((id) => provider(id, success(id), calls)));
		await expect(router.search(params(), { ...context(), signal, userSignal: signal })).resolves.toMatchObject({
			status: "failed", details: { error: { code: "ABORTED" } },
		});
		expect(calls).toEqual([]);
	});

	it.each(["success", "failed"] as const)("请求期间取消后不返回 %s 结果或继续切换", async (outcome) => {
		const calls: string[] = [];
		const controller = new AbortController();
		const first: WebSearchProvider = { id: "brave_api", async search() {
			calls.push("brave_api"); controller.abort();
			return outcome === "success" ? success("brave_api") : failed("brave_api");
		} };
		const router = new SearchProviderRouter([first, provider("exa_api", success("exa_api"), calls)]);
		await expect(router.search(params(), { ...context(), signal: controller.signal, userSignal: controller.signal })).resolves.toMatchObject({
			status: "failed", details: { error: { code: "ABORTED" } },
		});
		expect(calls).toEqual(["brave_api"]);
	});

	it("总截止时间阻止后续提供方和 DDG", async () => {
		let now = 0;
		const calls: string[] = [];
		const first: WebSearchProvider = { id: "brave_api", async search() {
			calls.push("brave_api"); now = 11; return failed("brave_api");
		} };
		const router = new SearchProviderRouter([first, provider("exa_api", success("exa_api"), calls), provider("duckduckgo_html", success("duckduckgo_html"), calls)]);
		await expect(router.search(params(), { now: () => now, deadlineAt: 10 })).resolves.toMatchObject({ status: "failed", details: { error: { code: "TIMEOUT" } } });
		expect(calls).toEqual(["brave_api"]);
	});

	it("正式提供方不保留跨调用冷却或失败缓存", async () => {
		const calls: string[] = [];
		const first: WebSearchProvider = { id: "brave_api", async search() {
			calls.push("brave_api");
			return calls.length === 1 ? failed("brave_api", "RATE_LIMITED", 429) : success("brave_api");
		} };
		const router = new SearchProviderRouter([first]);
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "failed" });
		await expect(router.search(params(), context())).resolves.toMatchObject({ status: "success", provider: "brave_api" });
		expect(calls).toEqual(["brave_api", "brave_api"]);
	});
});
