import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WebHttpResponse } from "../../../src/harness/web-tools/network/types.ts";
import { deferred, deferredVoid } from "../../helpers/async.ts";
import { httpResponse } from "../../helpers/http.ts";
import { useWebSearch } from "./search-fixture.ts";

const fixture = useWebSearch();
beforeEach(() => {
	const { websearch } = fixture.config;
	websearch.primary_providers = ["brave_api", "exa_api", "tavily", "exa_mcp"];
	Object.assign(websearch.exa_api, { enabled: true, api_key: "exa-key" });
	Object.assign(websearch.tinyfish, { enabled: true, api_key: "tinyfish-key" });
});

function response(provider: "brave_api" | "exa_api" | "tinyfish", pages: string[]): WebHttpResponse {
	const results = pages.map((page) => ({ title: `${provider} ${page}`, url: `https://example.com/${page}` }));
	return httpResponse(200, JSON.stringify(provider === "brave_api" ? { grounding: { generic: results } } : { results }));
}

describe("主辅搜索流程", () => {
	it("主链和辅助请求并发启动，按配置顺序合并而非完成顺序", async () => {
		const { config, runtime, fetchImpl } = fixture;
		config.websearch.primary_providers = ["brave_api", "tavily", "exa_mcp"];
		config.websearch.auxiliary_providers = ["tinyfish", "exa_api", "anysearch"];
		const primary = deferred<WebHttpResponse>();
		const auxiliary = deferred<WebHttpResponse>();
		fetchImpl.mockImplementation(async (url) => {
			if (url.hostname === "api.search.brave.com") return primary.promise;
			if (url.hostname === "api.search.tinyfish.ai") return auxiliary.promise;
			return response("exa_api", ["exa"]);
		});
		const pending = runtime.search({ query: "pi docs" }, { toolCallId: "parallel" });
		try {
			await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
		} finally {
			auxiliary.resolve(response("tinyfish", ["tinyfish"]));
			primary.resolve(response("brave_api", ["brave"]));
		}
		await expect(pending).resolves.toMatchObject({ details: { status: "success", providers: ["brave_api", "tinyfish", "exa_api"], results: [
			{ rank: 1, provider: "brave_api" }, { rank: 2, provider: "tinyfish" }, { rank: 3, provider: "exa_api" },
		], attempts: [{ role: "primary" }, { role: "auxiliary" }, { role: "auxiliary" }] } });
	});

	it("主组结果被域名过滤后继续回退，辅助失败不影响成功结果", async () => {
		fixture.fetchImpl.mockImplementation(async (url) => {
			if (url.hostname === "api.search.brave.com") return httpResponse(200, JSON.stringify({ grounding: { generic: [{ title: "Excluded", url: "https://outside.test/" }] } }));
			if (url.hostname === "api.exa.ai") return response("exa_api", ["docs"]);
			return httpResponse(503, "unavailable");
		});
		await expect(fixture.runtime.search({ query: "site:example.com pi" }, { toolCallId: "filtered-fallback" }))
			.resolves.toMatchObject({ details: { providers: ["exa_api"], attempts: [
				{ provider: "brave_api", result_count: 0 }, { provider: "exa_api", result_count: 1 },
				{ provider: "tinyfish", error: { code: "HTTP_ERROR" } },
			] } });
	});

	it("主组全部失败时仍返回辅助结果，全部失败时保留错误和尝试记录", async () => {
		fixture.fetchImpl.mockImplementation(async (url) => url.hostname === "api.search.tinyfish.ai" ? response("tinyfish", ["docs"]) : httpResponse(429, "limited"));
		await expect(fixture.runtime.search({ query: "pi" }, { toolCallId: "auxiliary-only" }))
			.resolves.toMatchObject({ details: { status: "success", providers: ["tinyfish"] } });
		fixture.fetchImpl.mockResolvedValue(httpResponse(503, "unavailable"));
		await expect(fixture.runtime.search({ query: "pi" }, { toolCallId: "all-failed" }))
			.resolves.toMatchObject({ details: { status: "failed", error: { code: "HTTP_ERROR" }, attempts: [
				{ provider: "brave_api", http_status: 503 }, { provider: "exa_api", http_status: 503 }, { provider: "tinyfish", http_status: 503 },
			] } });
	});

	it.each(["brave_api", "tinyfish"] as const)("总截止时间保留已完成的 %s 结果，不启动后续回退", async (completed) => {
		fixture.config.websearch.total_deadline_seconds = 1;
		fixture.fetchImpl.mockImplementation(async (url, init) => {
			const provider = url.hostname === "api.search.brave.com" ? "brave_api" : "tinyfish";
			if (provider === completed) return response(provider, ["docs"]);
			return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		});
		const pending = fixture.runtime.search({ query: "pi" }, { toolCallId: "deadline" });
		await expect(pending).resolves.toMatchObject({ details: { status: "success", providers: [completed], attempts: expect.arrayContaining([
			expect.objectContaining({ provider: completed, status: "success", result_count: 1 }),
			expect.objectContaining({ status: "failed", error: { code: "TIMEOUT", message: "websearch deadline exceeded." } }),
		]) } });
		expect(fixture.fetchImpl).toHaveBeenCalledTimes(2);
	});

	it.each(["before", "during"] as const)("用户在 %s 阶段取消搜索，不返回部分结果或启动回退", async (phase) => {
		const controller = new AbortController();
		const started = deferredVoid();
		fixture.fetchImpl.mockImplementation(async (url, init) => {
			if (url.hostname === "api.search.brave.com") return response("brave_api", ["docs"]);
			started.resolve();
			return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		});
		if (phase === "before") controller.abort();
		const pending = fixture.runtime.search({ query: "pi" }, { toolCallId: "cancel", signal: controller.signal });
		if (phase === "during") { await started.promise; controller.abort(); }
		await expect(pending).resolves.toMatchObject({ details: { status: "failed", error: { code: "ABORTED" } } });
		expect(fixture.fetchImpl).toHaveBeenCalledTimes(phase === "before" ? 0 : 2);
	});
});
