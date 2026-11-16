import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebSearchProviderId } from "../../../src/harness/web-tools/core/types.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { httpResponse } from "../../helpers/http.ts";
import { useWebSearch } from "./search-fixture.ts";

const fixture = useWebSearch();
const now = Date.parse("2026-11-16T12:34:56Z");
type ApiProvider = Exclude<WebSearchProviderId, "exa_mcp">;

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(now);
	fixture.config.websearch.exclude_domains = [];
});
afterEach(() => vi.restoreAllMocks());

async function searchRequest(id: ApiProvider, query: string): Promise<unknown> {
	fixture.config.websearch.brave_api.enabled = false;
	Object.assign(fixture.config.websearch[id], { enabled: true, api_key: "test-key" });
	const results = [{ title: "Pi", url: "https://example.com/docs" }];
	fixture.fetchImpl.mockResolvedValue(httpResponse(200, JSON.stringify(
		id === "brave_api" ? { grounding: { generic: results } }
			: id === "anysearch" ? { code: 0, data: { results } } : { results },
	)));
	await expect(fixture.runtime.search({ query }, { toolCallId: "dates" }))
		.resolves.toMatchObject({ details: { status: "success", query, providers: [id] } });
	expect(fixture.fetchImpl).toHaveBeenCalledOnce();
	const request = fixture.fetchImpl.mock.calls[0];
	if (request === undefined) throw new Error("missing HTTP request");
	return request[1].method === "GET" ? Object.fromEntries(request[0].searchParams) : JSON.parse(request[1].body ?? "null");
}

describe("搜索日期语法", () => {
	it.each([
		{ id: "brave_api", expected: { q: 'Pi "release notes" site:example.com', freshness: "2026-01-01to2026-06-01" } },
		{ id: "exa_api", expected: { query: 'Pi "release notes"', includeDomains: ["example.com"], startPublishedDate: "2026-01-01T00:00:00.000Z", endPublishedDate: "2026-06-01T00:00:00.000Z" } },
		{ id: "tavily", expected: { query: 'Pi "release notes"', include_domains: ["example.com"], start_date: "2026-01-01", end_date: "2026-06-01", filter_by_published_date: true } },
		{ id: "tinyfish", expected: { query: 'Pi "release notes"', include_domains: "example.com", after_date: "2026-01-01", before_date: "2026-06-01" } },
		{ id: "anysearch", expected: { query: 'Pi "release notes" after:2026-01-01 before:2026-06-01 site:example.com' } },
	] as const)("$id 将限定站点与日期的短语搜索映射到请求", async ({ id, expected }) => {
		expect(await searchRequest(id, 'Pi "release notes" after:2026-01-01 before:2026-06-01 site:example.com'))
			.toMatchObject(expected);
	});

	it.each(["after:2026-01-01", "before:2026-06-01"])("Brave 透传单边日期 %s，不伪造另一端", async (filter) => {
		const request = await searchRequest("brave_api", `Pi ${filter}`);
		expect(request).toMatchObject({ q: `Pi ${filter}` });
		expect(request).not.toHaveProperty("freshness");
	});

	it.each([
		{ id: "brave_api", expected: { q: "Pi", freshness: "pw" } },
		{ id: "exa_api", expected: { query: "Pi", startPublishedDate: "2026-11-09T12:34:56.000Z" } },
		{ id: "tavily", expected: { query: "Pi", start_date: "2026-11-09", filter_by_published_date: true } },
		{ id: "tinyfish", expected: { query: "Pi", recency_minutes: "10080" } },
		{ id: "anysearch", expected: { query: "Pi recent:7d" } },
	] as const)("$id 处理 recent:7d", async ({ id, expected }) => {
		expect(await searchRequest(id, "Pi recent:7d")).toMatchObject(expected);
	});

	it("Brave 将非预设的最近天数转换为日期范围", async () => {
		expect(await searchRequest("brave_api", "Pi recent:3d")).toMatchObject({ q: "Pi", freshness: "2026-11-13to2026-11-16" });
	});

	it("recent: 的并发调用合并，不因执行时间变化重复请求", async () => {
		fixture.config.websearch.brave_api.enabled = false;
		Object.assign(fixture.config.websearch.exa_api, { enabled: true, api_key: "test-key" });
		const started = deferredVoid();
		const release = deferredVoid();
		fixture.fetchImpl.mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return httpResponse(200, JSON.stringify({ results: [{ title: "Pi", url: "https://example.com/docs" }] }));
		});
		const first = fixture.runtime.search({ query: "Pi recent:7d" }, { toolCallId: "recent-first" });
		await started.promise;
		vi.mocked(Date.now).mockReturnValue(now + 1000);
		const second = fixture.runtime.search({ query: "Pi recent:7d" }, { toolCallId: "recent-second" });
		release.resolve();
		await expect(Promise.all([first, second])).resolves.toMatchObject([
			{ details: { status: "success" } }, { details: { status: "success" } },
		]);
		expect(fixture.fetchImpl).toHaveBeenCalledOnce();
	});

	it.each([
		"Pi after:2026-02-29", "Pi recent:0d", "Pi recent:3651d",
		"Pi after:2026-06-01 before:2026-01-01", "Pi recent:7d after:2026-01-01",
		"Pi after:2026-01-01 after:2026-02-01", "site:example.com after:2026-01-01",
	])("非法日期查询 %s 在请求前返回 INVALID_ARGUMENT", async (query) => {
		await expect(fixture.runtime.search({ query }, { toolCallId: "invalid-dates" }))
			.resolves.toMatchObject({ details: { status: "failed", error: { code: "INVALID_ARGUMENT" } } });
		expect(fixture.fetchImpl).not.toHaveBeenCalled();
	});

	it("主引擎失败后，回退和辅助引擎仍分别转换或透传日期词", async () => {
		fixture.config.websearch.exa_api.enabled = true;
		fixture.config.websearch.exa_api.api_key = "test-key";
		fixture.config.websearch.anysearch.enabled = true;
		const results = [{ title: "Pi", url: "https://example.com/docs" }];
		fixture.fetchImpl.mockImplementation(async (url) => {
			if (url.hostname === "api.exa.ai") return httpResponse(503, "unavailable");
			return httpResponse(200, JSON.stringify(url.hostname === "api.search.brave.com"
				? { grounding: { generic: results } } : { code: 0, data: { results } }));
		});
		await expect(fixture.runtime.search({ query: "Pi after:2026-01-01" }, { toolCallId: "fallback-dates" }))
			.resolves.toMatchObject({ details: { status: "success", providers: ["brave_api"] } });
		expect(fixture.fetchImpl).toHaveBeenCalledTimes(3);
		for (const [url, init] of fixture.fetchImpl.mock.calls) {
			if (url.hostname === "api.exa.ai") expect(JSON.parse(init.body ?? "null")).toMatchObject({ query: "Pi", startPublishedDate: "2026-01-01T00:00:00.000Z" });
			else if (url.hostname === "api.search.brave.com") expect(url.searchParams.get("q")).toBe("Pi after:2026-01-01");
			else expect(JSON.parse(init.body ?? "null")).toMatchObject({ query: "Pi after:2026-01-01" });
		}
	});
});
