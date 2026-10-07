import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebSearchRuntime } from "../../../src/harness/web-tools/search/websearch-runtime.ts";
import type { WebSearchCapability } from "../../../src/harness/web-tools/core/runtime-types.ts";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.ts";
import { normalizeProviderResponse } from "../../../src/harness/web-tools/search-providers/api-provider.ts";
import { normalizeSearchParams } from "../../../src/harness/web-tools/search-providers/query.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { httpResponse } from "../../helpers/http.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { preserveEnv } from "../../helpers/lifecycle.ts";

preserveEnv("ANYSEARCH_API_KEY");
let config: ReturnType<typeof defaultWebToolsConfig>;
let dispatcher: Agent;
let runtime: WebSearchCapability;
const fetchImpl = vi.fn<WebHttpFetch>();
const rows = [{ title: "Pi docs", url: "https://example.com/docs", content: "Pi reference", snippet: "Pi summary" }];
function response() { return httpResponse(200, JSON.stringify({ code: 0, data: { results: rows } })); }

beforeEach(() => {
	delete process.env.ANYSEARCH_API_KEY;
	config = defaultWebToolsConfig();
	for (const id of config.websearch.primary_providers) config.websearch[id].enabled = false;
	config.websearch.tinyfish.enabled = false;
	dispatcher = new Agent();
	fetchImpl.mockReset().mockImplementation(async () => response());
	runtime = createWebSearchRuntime({
		loadConfig: async () => structuredClone(config), getDispatcher: async () => dispatcher,
		fetchImpl, now: () => Date.now(),
	});
});
afterEach(async () => { await runtime.close(); await dispatcher.close(); });

const search = (limit = 8) => runtime.search({ query: "site:example.com Pi", limit }, { toolCallId: "anysearch" });

describe("AnySearch 辅助搜索", () => {
	it.each(["", "   ", "$ANYSEARCH_API_KEY", "${ANYSEARCH_API_KEY}"])("凭据 %j 不可用时直接匿名访问", async (key) => {
		config.websearch.anysearch.api_key = key;
		await expect(search()).resolves.toMatchObject({ details: { status: "success", providers: ["anysearch"],
			results: [{ provider: "anysearch", snippet: "Pi reference\n\nPi summary" }],
			attempts: [{ provider: "anysearch", role: "auxiliary", status: "success" }] } });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const request = fetchImpl.mock.calls[0];
		expect(request?.[0].toString()).toBe("https://api.anysearch.com/v1/search");
		expect(request?.[1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" } });
		expect(request?.[1].headers).not.toHaveProperty("Authorization");
		expect(JSON.parse(request?.[1].body ?? "null")).toEqual({ query: "Pi site:example.com -site:csdn.com -site:gitcode.com", max_results: config.websearch.anysearch.max_results, format: "json" });
	});

	it.each(["literal-key", "$ANYSEARCH_API_KEY", "${ANYSEARCH_API_KEY}"])("凭据 %j 可用时发送 Bearer", async (key) => {
		config.websearch.anysearch.api_key = key;
		process.env.ANYSEARCH_API_KEY = "literal-key";
		await expect(search()).resolves.toMatchObject({ details: { status: "success" } });
		expect(fetchImpl.mock.calls[0]?.[1].headers["Authorization"]).toBe("Bearer literal-key");
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it.each([401, 402, 403])("密钥请求返回 %i 时只重试一次匿名请求，共用超时信号", async (status) => {
		config.websearch.anysearch.api_key = "bad-key";
		fetchImpl.mockResolvedValueOnce(httpResponse(status, '{"code":-1,"message":"unavailable"}'));
		await expect(search()).resolves.toMatchObject({ details: { status: "success", providers: ["anysearch"] } });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const [first, second] = fetchImpl.mock.calls;
		expect(first?.[1].headers["Authorization"]).toBe("Bearer bad-key");
		expect(second?.[1].headers).not.toHaveProperty("Authorization");
		expect(second?.[1].body).toBe(first?.[1].body);
		expect(second?.[1].signal).toBe(first?.[1].signal);
	});

	it("匿名额度耗尽不继续重试，也不泄漏响应中的自动生成凭据", async () => {
		config.websearch.anysearch.api_key = "bad-key";
		fetchImpl.mockImplementation(async () => httpResponse(402, '{"code":-1,"message":"username=user password=secret api_key=generated-key"}'));
		const result = await search();
		expect(result).toMatchObject({ details: { status: "failed", error: { code: "QUOTA_EXHAUSTED" }, http_status: 402 } });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		for (const secret of ["bad-key", "password", "secret", "generated-key"]) expect(JSON.stringify(result)).not.toContain(secret);
	});

	it.each([400, 404, 429, 502])("密钥请求返回 %i 时不切换匿名访问", async (status) => {
		config.websearch.anysearch.api_key = "key";
		fetchImpl.mockImplementation(async () => httpResponse(status, "failed"));
		await expect(search()).resolves.toMatchObject({ details: { status: "failed", http_status: status } });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("连接失败不切换匿名访问，错误中的密钥被脱敏", async () => {
		config.websearch.anysearch.api_key = "secret-key";
		fetchImpl.mockRejectedValue(new Error("failed secret-key"));
		const result = await search();
		expect(result).toMatchObject({ details: { error: { code: "CONNECTION_FAILED" } } });
		expect(JSON.stringify(result)).not.toContain("secret-key");
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("认证请求被取消时不启动匿名重试", async () => {
		config.websearch.anysearch.api_key = "key";
		const controller = new AbortController();
		fetchImpl.mockImplementation(async () => { controller.abort(); return httpResponse(401, "invalid key"); });
		await expect(runtime.search({ query: "Pi" }, { toolCallId: "cancel", signal: controller.signal }))
			.resolves.toMatchObject({ details: { error: { code: "ABORTED" } } });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it.each(["provider", "total"] as const)("匿名重试不重置 %s 超时预算", async (budget) => {
		config.websearch.anysearch.api_key = "key";
		if (budget === "provider") config.websearch.anysearch.timeout_seconds = 1;
		else config.websearch.total_deadline_seconds = 1;
		fetchImpl.mockImplementation(async (_url, init) => {
			await delay(650, undefined, { signal: init.signal });
			return init.headers["Authorization"] === undefined ? response() : httpResponse(401, "invalid key");
		});
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "TIMEOUT" } } });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("禁用后不请求，最多向 API 请求 10 条", async () => {
		config.websearch.anysearch.enabled = false;
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "NO_PROVIDER_AVAILABLE" } } });
		expect(fetchImpl).not.toHaveBeenCalled();
		config.websearch.anysearch.enabled = true;
		config.websearch.anysearch.max_results = 10;
		await search(20);
		expect(JSON.parse(fetchImpl.mock.calls[0]?.[1].body ?? "null")).toMatchObject({ max_results: 10 });
	});

	it("匿名请求在途时配置密钥，同名搜索使用新凭据独立请求", async () => {
		const started = deferredVoid();
		const release = deferredVoid();
		fetchImpl.mockImplementation(async (_url, init) => {
			if (init.headers["Authorization"] === undefined) { started.resolve(); await release.promise; }
			return response();
		});
		const first = search();
		await started.promise;
		try {
			process.env.ANYSEARCH_API_KEY = "new-key";
			await expect(search()).resolves.toMatchObject({ details: { status: "success" } });
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(fetchImpl.mock.calls[1]?.[1].headers["Authorization"]).toBe("Bearer new-key");
		} finally { release.resolve(); }
		await expect(first).resolves.toMatchObject({ details: { status: "success" } });
	});

	it("与主结果汇总，域名过滤、去重和条数限制沿用路由规则", async () => {
		config.websearch.brave_api.enabled = true;
		config.websearch.brave_api.api_key = "brave-key";
		config.websearch.brave_api.max_results = 1;
		fetchImpl.mockImplementation(async (url) => url.hostname === "api.search.brave.com"
			? httpResponse(200, JSON.stringify({ grounding: { generic: rows } }))
			: httpResponse(200, JSON.stringify({ code: 0, data: { results: [
				{ title: "Excluded", url: "https://excluded.test/" },
				{ title: "Duplicate", url: "https://example.com/docs?utm_source=anysearch#top" },
				{ title: "Auxiliary", url: "https://example.com/extra", snippet: "Pi extra" },
				{ title: "Overflow", url: "https://example.com/overflow" },
			] } })));
		await expect(search(2)).resolves.toMatchObject({ details: { providers: ["brave_api", "anysearch"], results: [
			{ rank: 1, provider: "brave_api", url: "https://example.com/docs" },
			{ rank: 2, provider: "anysearch", url: "https://example.com/extra", snippet: "Pi extra" },
		] } });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("snippet 可单独使用，合法空结果保持为空", () => {
		const params = normalizeSearchParams({ query: "Pi" }, 8);
		expect(normalizeProviderResponse("anysearch", { code: 0, data: { results: [{ title: "", url: "https://example.com/", snippet: "Pi snippet" }] } }, params, 42))
			.toMatchObject({ status: "success", results: [{ title: "https://example.com/", snippet: "Pi snippet" }] });
		expect(normalizeProviderResponse("anysearch", { code: 0, data: { results: [] } }, params, 42))
			.toMatchObject({ status: "success", results: [] });
	});

	it.each([{ code: -1, message: "secret" }, { code: 0 }, { code: 0, data: { results: {} } }])("非法响应不当作成功空结果 %j", (raw) => {
		expect(normalizeProviderResponse("anysearch", raw, normalizeSearchParams({ query: "Pi" }, 8), 42))
			.toMatchObject({ status: "failed", details: { error: { code: "PARSE_FAILED" } } });
	});
});
