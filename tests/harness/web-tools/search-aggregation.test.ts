import { describe, expect, it, vi } from "vitest";
import { SearchProviderRouter } from "../../../src/harness/web-tools/search-providers/router.ts";
import { normalizeSearchParams } from "../../../src/harness/web-tools/search-providers/query.ts";
import type { SearchProviderResult, WebSearchProvider } from "../../../src/harness/web-tools/search-providers/types.ts";
import type { WebSearchErrorCode, WebSearchProviderId } from "../../../src/harness/web-tools/core/types.ts";
import { deferred, deferredVoid } from "../../helpers/async.ts";

function success(id: WebSearchProviderId, pages: string[]): SearchProviderResult {
	return { status: "success", provider: id, downloadedBytes: 100, results: pages.map((page, index) => ({
		rank: index + 1, title: `${id} ${page}`, url: `https://example.com/${page}`,
	})) };
}
function failed(id: WebSearchProviderId, code: WebSearchErrorCode = "HTTP_ERROR"): SearchProviderResult {
	return { status: "failed", provider: id, details: { status: "failed", provider: id, error: { code, message: code } } };
}
function provider(id: WebSearchProviderId, pages: string[], maxResults = 5): WebSearchProvider {
	return { id, maxResults, search: vi.fn(async () => success(id, pages)) };
}
const params = (limit = 8) => normalizeSearchParams({ query: "example", limit }, 8);
const context = () => ({ now: () => 0, deadlineAt: 20_000 });

describe("主辅搜索汇总", () => {
	it("独立限制各提供方和总数，跨提供方去重时保留主结果并连续编号", async () => {
		const primary = provider("brave_api", ["a", "b", "dropped"], 2);
		const auxiliary = provider("tinyfish", ["b", "c", "d", "dropped"], 3);
		const result = await new SearchProviderRouter({ primary: [primary], auxiliary: [auxiliary] }).search(params(4), context());
		expect(primary.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }), expect.anything());
		expect(auxiliary.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }), expect.anything());
		expect(result).toMatchObject({ status: "success", providers: ["brave_api", "tinyfish"], downloadedBytes: 200,
			results: [
				{ rank: 1, title: "brave_api a", provider: "brave_api" },
				{ rank: 2, title: "brave_api b", provider: "brave_api" },
				{ rank: 3, title: "tinyfish c", provider: "tinyfish" },
				{ rank: 4, title: "tinyfish d", provider: "tinyfish" },
			],
			attempts: [{ role: "primary", result_count: 2 }, { role: "auxiliary", result_count: 3 }],
		});
	});

	it("主结果已填满总限制也请求全部辅助提供方，不突破总限制", async () => {
		const primary = provider("brave_api", ["a", "b"]);
		const tinyfish = provider("tinyfish", ["c"]);
		const exa = provider("exa_api", ["d"]);
		const result = await new SearchProviderRouter({ primary: [primary], auxiliary: [tinyfish, exa] }).search(params(1), context());
		for (const item of [primary, tinyfish, exa]) expect(item.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }), expect.anything());
		expect(result).toMatchObject({ status: "success", providers: ["brave_api"], results: [{ rank: 1, provider: "brave_api" }] });
	});

	it("主链和全部辅助请求同时启动，辅助先完成仍按配置顺序合并", async () => {
		const primaryResult = deferred<SearchProviderResult>();
		const firstAuxiliaryResult = deferred<SearchProviderResult>();
		const primary = { ...provider("brave_api", []), search: vi.fn(() => primaryResult.promise) };
		const tinyfish = { ...provider("tinyfish", []), search: vi.fn(() => firstAuxiliaryResult.promise) };
		const exa = provider("exa_api", ["exa"]);
		const pending = new SearchProviderRouter({ primary: [primary], auxiliary: [tinyfish, exa] }).search(params(), context());
		for (const item of [primary, tinyfish, exa]) expect(item.search).toHaveBeenCalledOnce();
		firstAuxiliaryResult.resolve(success("tinyfish", ["tinyfish"]));
		primaryResult.resolve(success("brave_api", ["brave"]));
		await expect(pending).resolves.toMatchObject({ status: "success", providers: ["brave_api", "tinyfish", "exa_api"],
			results: [{ provider: "brave_api" }, { provider: "tinyfish" }, { provider: "exa_api" }],
			attempts: [{ provider: "brave_api" }, { provider: "tinyfish" }, { provider: "exa_api" }],
		});
	});

	it("主组逐个回退至非空结果，辅助失败不影响成功结果", async () => {
		const brave = { ...provider("brave_api", []), search: vi.fn(async () => failed("brave_api")) };
		const exa = provider("exa_api", []);
		const tavily = provider("tavily", ["a"]);
		const ddg = provider("duckduckgo_html", ["not-used"]);
		const tinyfish = { ...provider("tinyfish", []), search: vi.fn(async () => failed("tinyfish", "TIMEOUT")) };
		await expect(new SearchProviderRouter({ primary: [brave, exa, tavily, ddg], auxiliary: [tinyfish] }).search(params(), context()))
			.resolves.toMatchObject({ status: "success", providers: ["tavily"], attempts: [
				{ provider: "brave_api", status: "failed" }, { provider: "exa_api", result_count: 0 },
				{ provider: "tavily", result_count: 1 }, { provider: "tinyfish", status: "failed" },
			] });
		expect(ddg.search).not.toHaveBeenCalled();
	});

	it.each([true, false])("主组不可用（有失败请求：%s）仍返回辅助结果", async (hasPrimary) => {
		const primary = { ...provider("brave_api", []), search: vi.fn(async () => failed("brave_api")) };
		await expect(new SearchProviderRouter({ primary: hasPrimary ? [primary] : [], auxiliary: [provider("tinyfish", ["a"])] })
			.search(params(), context())).resolves.toMatchObject({ status: "success", providers: ["tinyfish"] });
	});

	it("总截止时间到期保留已完成的主结果，不启动后续回退", async () => {
		let now = 0;
		const mainDone = deferredVoid();
		const primary = { ...provider("brave_api", []), async search() {
			queueMicrotask(() => mainDone.resolve());
			return success("brave_api", ["a"]);
		} };
		const tinyfish = { ...provider("tinyfish", []), async search() {
			await mainDone.promise;
			now = 20_000;
			return failed("tinyfish", "TIMEOUT");
		} };
		await expect(new SearchProviderRouter({ primary: [primary], auxiliary: [tinyfish] }).search(params(), { now: () => now, deadlineAt: 20_000 }))
			.resolves.toMatchObject({ status: "success", providers: ["brave_api"], attempts: [{ status: "success" }, { error: { code: "TIMEOUT" } }] });
	});

	it("主链超时也保留提前完成的辅助结果", async () => {
		let now = 0;
		const auxiliaryDone = deferredVoid();
		const primary = { ...provider("brave_api", []), async search() {
			await auxiliaryDone.promise;
			now = 20_000;
			return failed("brave_api", "TIMEOUT");
		} };
		const tinyfish = { ...provider("tinyfish", []), async search() {
			queueMicrotask(() => auxiliaryDone.resolve());
			return success("tinyfish", ["a"]);
		} };
		const next = provider("exa_api", ["not-used"]);
		await expect(new SearchProviderRouter({ primary: [primary, next], auxiliary: [tinyfish] }).search(params(), { now: () => now, deadlineAt: 20_000 }))
			.resolves.toMatchObject({ status: "success", providers: ["tinyfish"] });
		expect(next.search).not.toHaveBeenCalled();
	});

	it("提供方意外抛错时取消其他在途请求并向上传播", async () => {
		const error = new Error("provider module failed to load");
		const primary = { ...provider("brave_api", []), async search(): Promise<SearchProviderResult> { throw error; } };
		let auxiliarySignal: AbortSignal | undefined;
		const tinyfish: WebSearchProvider = { ...provider("tinyfish", []), async search(_params, context) {
			auxiliarySignal = context.signal;
			await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return failed("tinyfish", "ABORTED");
		} };
		await expect(new SearchProviderRouter({ primary: [primary], auxiliary: [tinyfish] }).search(params(), context())).rejects.toBe(error);
		expect(auxiliarySignal?.aborted).toBe(true);
	});

	it("用户取消传播到主辅请求，不返回部分结果", async () => {
		const controller = new AbortController();
		const started = deferredVoid();
		const primary = provider("brave_api", ["a"]);
		const tinyfish: WebSearchProvider = { ...provider("tinyfish", []), async search(_params, context) {
			started.resolve();
			await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return failed("tinyfish", "ABORTED");
		} };
		const pending = new SearchProviderRouter({ primary: [primary], auxiliary: [tinyfish] }).search(params(), {
			...context(), signal: controller.signal, userSignal: controller.signal,
		});
		await started.promise;
		controller.abort();
		await expect(pending).resolves.toMatchObject({ status: "failed", details: { error: { code: "ABORTED" } } });
	});
});
