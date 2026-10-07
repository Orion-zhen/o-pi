import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as configModule from "../../../src/harness/web-tools/config.ts";
import * as apiModule from "../../../src/harness/web-tools/search-providers/api-provider.ts";
import * as ddgModule from "../../../src/harness/web-tools/search-providers/duckduckgo-html-provider.ts";
import type { FormalWebSearchProviderId, WebToolsRuntime } from "../../../src/harness/web-tools/core/types.ts";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.ts";
import { createWebToolsRuntime } from "../../../src/harness/web-tools/web-tools-runtime.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { httpResponse } from "../../helpers/http.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const network = vi.hoisted(() => ({ fetch: vi.fn<WebHttpFetch>() }));
vi.mock("undici/index.js", async (importOriginal) => ({
	...await importOriginal<typeof import("undici")>(),
	fetch: network.fetch,
}));

const runtimes: WebToolsRuntime[] = [];
const temp = useTempDir("o-pi-web-runtime-");
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES", "BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY");

beforeEach(() => {
	process.env.PI_WEB_TOOLS_CONFIG = path.join(temp.path, "config.jsonc");
	process.env.PI_WEB_TOOLS_COOKIES = path.join(temp.path, "missing-cookies.txt");
	process.env.BRAVE_SEARCH_API_KEY = "test-key";
	delete process.env.EXA_API_KEY;
	delete process.env.TAVILY_API_KEY;
	network.fetch.mockReset().mockImplementation(async () => httpResponse(200, "hello world", { "content-type": "text/plain" }));
});

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	vi.restoreAllMocks();
});

describe("web-tools runtime", () => {
	it("api_key 为空时不创建 provider，引用可用后自动恢复", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.brave_api.api_key = "";
		vi.spyOn(configModule, "loadWebToolsConfig").mockImplementation(async () => structuredClone(config));
		const createApi = vi.spyOn(apiModule, "searchApiProvider");
		const createDdg = vi.spyOn(ddgModule, "searchDuckDuckGoProvider");
		const html = await readFile(new URL("./fixtures/websearch/results.html", import.meta.url), "utf8");
		network.fetch.mockImplementation(async (url) => url.hostname === "html.duckduckgo.com"
			? httpResponse(200, html, { "content-type": "text/html" })
			: searchResponse("brave_api"));
		const runtime = trackRuntime();

		await expect(runtime.search({ query: "example", limit: 1 }, { toolCallId: "empty-key" })).resolves.toMatchObject({ details: { provider: "duckduckgo_html" } });
		expect(createApi).not.toHaveBeenCalled();
		config.websearch.brave_api.api_key = "$BRAVE_SEARCH_API_KEY";
		await expect(runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "restored-key" })).resolves.toMatchObject({ details: { provider: "brave_api" } });
		expect(createApi).toHaveBeenCalledOnce();
		expect(createDdg).toHaveBeenCalledOnce();
	});

	it.each(["brave_api", "exa_api", "tavily"] as const)("只配置 %s 时仍使用该正式 provider", async (selected) => {
		const config = defaultWebToolsConfig();
		for (const id of ["brave_api", "exa_api", "tavily"] as const) config.websearch[id].enabled = id === selected;
		config.websearch[selected].api_key = "literal-key";
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		const createApi = vi.spyOn(apiModule, "searchApiProvider");
		const createDdg = vi.spyOn(ddgModule, "searchDuckDuckGoProvider");
		network.fetch.mockImplementation(async () => searchResponse(selected));
		await expect(trackRuntime().search({ query: "official pi docs", limit: 1 }, { toolCallId: selected })).resolves.toMatchObject({ details: { status: "success", provider: selected } });
		expect(createApi).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: selected }), expect.anything(), expect.anything());
		expect(createDdg).not.toHaveBeenCalled();
	});

	it("固定顺序贯穿真实请求适配，失败和空结果后继续，Tavily 有结果即停止", async () => {
		const config = defaultWebToolsConfig();
		for (const id of ["brave_api", "exa_api", "tavily"] as const) {
			config.websearch[id].enabled = true;
			config.websearch[id].api_key = "test-key";
		}
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		const createDdg = vi.spyOn(ddgModule, "searchDuckDuckGoProvider");
		network.fetch.mockImplementation(async (url) => {
			if (url.toString().startsWith(config.websearch.brave_api.endpoint)) return httpResponse(503, "unavailable");
			if (url.toString().startsWith(config.websearch.exa_api.endpoint)) return httpResponse(200, '{"results":[]}');
			if (url.toString().startsWith(config.websearch.tavily.endpoint)) return searchResponse("tavily");
			throw new Error(`unexpected provider: ${url}`);
		});
		await expect(trackRuntime().search({ query: "research papers about agents", limit: 8 }, { toolCallId: "fixed-order" })).resolves.toMatchObject({
			details: { status: "success", provider: "tavily", attempts: [
				{ provider: "brave_api", status: "failed", http_status: 503 },
				{ provider: "exa_api", status: "success", result_count: 0 },
				{ provider: "tavily", status: "success", result_count: 1 },
			] },
		});
		expect(network.fetch).toHaveBeenCalledTimes(3);
		expect(createDdg).not.toHaveBeenCalled();
	});

	it("按配置顺序跳过禁用和缺少凭据的引擎，DDG 可排在正式 API 前", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.provider_order = ["tavily", "exa_api", "duckduckgo_html", "brave_api"];
		config.websearch.tavily.enabled = false;
		config.websearch.tavily.api_key = "available-but-disabled";
		config.websearch.exa_api.api_key = "";
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		const html = await readFile(new URL("./fixtures/websearch/results.html", import.meta.url), "utf8");
		network.fetch.mockResolvedValue(httpResponse(200, html, { "content-type": "text/html" }));
		await expect(trackRuntime().search({ query: "example", limit: 1 }, { toolCallId: "ddg-first" })).resolves.toMatchObject({
			details: { status: "success", provider: "duckduckgo_html", attempts: [{ provider: "duckduckgo_html" }] },
		});
		expect(network.fetch).toHaveBeenCalledOnce();
		expect(network.fetch.mock.calls[0]?.[0].hostname).toBe("html.duckduckgo.com");
	});

	it("调整顺序不会合并到旧顺序的进行中请求，全部禁用后不发送请求", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.exa_api.api_key = "exa-key";
		vi.spyOn(configModule, "loadWebToolsConfig").mockImplementation(async () => structuredClone(config));
		const started = deferredVoid();
		const release = deferredVoid();
		network.fetch.mockImplementation(async (url) => {
			if (url.toString().startsWith(config.websearch.brave_api.endpoint)) {
				started.resolve();
				await release.promise;
				return searchResponse("brave_api");
			}
			return searchResponse("exa_api");
		});
		const runtime = trackRuntime();
		const params = { query: "same query", limit: 1 };
		const first = runtime.search(params, { toolCallId: "old-order" });
		await started.promise;
		try {
			config.websearch.provider_order = ["exa_api", "brave_api", "tavily", "duckduckgo_html"];
			await expect(runtime.search(params, { toolCallId: "new-order" })).resolves.toMatchObject({ details: { status: "success", provider: "exa_api" } });
		} finally { release.resolve(); }
		await expect(first).resolves.toMatchObject({ details: { status: "success", provider: "brave_api" } });
		for (const id of config.websearch.provider_order) config.websearch[id].enabled = false;
		await expect(runtime.search(params, { toolCallId: "all-disabled" })).resolves.toMatchObject({
			details: { status: "failed", error: { code: "NO_PROVIDER_AVAILABLE" }, attempts: [] },
		});
		expect(network.fetch).toHaveBeenCalledTimes(2);
	});

	it("响应先按域名过滤再截取 limit，不因前排被排除而误判为空", async () => {
		const config = defaultWebToolsConfig();
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockResolvedValue(httpResponse(200, JSON.stringify({ web: { results: [
			{ title: "Excluded", url: "https://example.org/" },
			{ title: "Allowed", url: "https://docs.example.com/" },
		] } })));
		await expect(trackRuntime().search({ query: "site:example.com 文档", limit: 1 }, { toolCallId: "filtered" })).resolves.toMatchObject({
			details: { status: "success", provider: "brave_api", results: [{ rank: 1, title: "Allowed", url: "https://docs.example.com/" }] },
		});
		expect(network.fetch).toHaveBeenCalledOnce();
	});

	it("失败请求不污染后续搜索，未调用时不发起网络请求", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.duckduckgo_html.enabled = false;
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockRejectedValueOnce(new Error("connection refused")).mockResolvedValue(searchResponse("brave_api"));
		const runtime = trackRuntime();
		expect(network.fetch).not.toHaveBeenCalled();
		await expect(runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "first" })).resolves.toMatchObject({ details: { status: "failed" } });
		await expect(runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "second" })).resolves.toMatchObject({ details: { status: "success" } });
		expect(network.fetch).toHaveBeenCalledTimes(2);
	});


	it("关闭会等待已开始的请求，再释放 dispatcher，并拒绝新调用", async () => {
		const started = deferredVoid();
		const release = deferredVoid();
		let dispatcher: Dispatcher | undefined;
		network.fetch.mockImplementation(async (_url, init) => {
			dispatcher = init.dispatcher;
			started.resolve();
			await release.promise;
			return httpResponse(200, "done", { "content-type": "text/plain" });
		});
		const runtime = trackRuntime();
		const result = runtime.fetch({ url: "https://example.com/" }, { toolCallId: "in-flight" });
		await started.promise;
		if (dispatcher === undefined) throw new Error("missing dispatcher");
		const close = vi.spyOn(dispatcher, "close");
		const closing = runtime.close();
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(close).not.toHaveBeenCalled();
			expect(() => runtime.fetch({ url: "https://example.com/" }, { toolCallId: "late" })).toThrow();
		} finally {
			release.resolve();
		}
		await expect(result).resolves.toMatchObject({ details: { status: "success" } });
		await closing;
		expect(close.mock.calls.filter((args) => args.length === 0)).toHaveLength(1);
	});

	it("网络配置变化时切换 dispatcher，相同配置复用并在关闭时全部释放", async () => {
		const configPath = path.join(temp.path, "config.jsonc");
		await writeFile(configPath, '{ "network": { "proxy": { "enabled": false } } }');
		const runtime = trackRuntime();
		await runtime.fetch({ url: "https://example.com/one" }, { toolCallId: "network-1" });
		await writeFile(configPath, '{ "network": { "proxy": { "enabled": true, "http_proxy": "http://127.0.0.1:7890" } } }');
		await runtime.fetch({ url: "https://example.com/two" }, { toolCallId: "network-2" });
		await runtime.fetch({ url: "https://example.com/three" }, { toolCallId: "network-3" });
		const [first, second, third] = network.fetch.mock.calls.map(([, init]) => init.dispatcher);
		if (first === undefined || second === undefined) throw new Error("missing dispatchers");
		expect(first).not.toBe(second);
		expect(second).toBe(third);
		const closeFirst = vi.spyOn(first, "close");
		const closeSecond = vi.spyOn(second, "close");
		await runtime.close();
		expect(closeFirst.mock.calls.filter((args) => args.length === 0)).toHaveLength(1);
		expect(closeSecond.mock.calls.filter((args) => args.length === 0)).toHaveLength(1);
	});

	it("配置文件错误返回 CONFIG_ERROR，修复后下一次调用重新读取", async () => {
		const configPath = path.join(temp.path, "config.jsonc");
		await writeFile(configPath, "{");
		const runtime = trackRuntime();
		await expect(runtime.fetch({ url: "https://example.com/" }, { toolCallId: "invalid-config" })).resolves.toMatchObject({ details: { error: { code: "CONFIG_ERROR" } } });
		await writeFile(configPath, "{}");
		await expect(runtime.fetch({ url: "https://example.com/" }, { toolCallId: "fixed-config" })).resolves.toMatchObject({ details: { status: "success" } });
	});


	it("并发搜索各用自身请求数据，完成后的相同查询重新请求", async () => {
		const createApi = vi.spyOn(apiModule, "searchApiProvider");
		network.fetch.mockImplementation(async () => searchResponse("brave_api"));
		const runtime = trackRuntime();
		const results = await Promise.all([
			runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "first" }),
			runtime.search({ query: "official pi reference", limit: 1 }, { toolCallId: "concurrent" }),
		]);
		results.push(await runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "again" }));
		expect(results.every((result) => result.details.status === "success")).toBe(true);
		expect(createApi).toHaveBeenCalledTimes(3);
		expect(network.fetch).toHaveBeenCalledTimes(3);
	});

	it("API key 热更新不干扰旧请求，相同查询使用新配置另行执行", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "old-key";
		const started = deferredVoid();
		const release = deferredVoid();
		const keys: string[] = [];
		network.fetch.mockImplementation(async (_url, init) => {
			const key = init.headers["X-Subscription-Token"];
			if (key === undefined) throw new Error("unexpected provider");
			keys.push(key);
			if (key === "old-key") {
				started.resolve();
				await release.promise;
			}
			return searchResponse("brave_api");
		});
		const runtime = trackRuntime();
		const params = { query: "official pi docs", limit: 1 };
		const first = runtime.search(params, { toolCallId: "old-config" });
		await started.promise;
		try {
			process.env.BRAVE_SEARCH_API_KEY = "new-key";
			await expect(runtime.search(params, { toolCallId: "new-config" })).resolves.toMatchObject({ details: { status: "success", provider: "brave_api" } });
			expect(keys).toEqual(["old-key", "new-key"]);
		} finally {
			release.resolve();
		}
		await expect(first).resolves.toMatchObject({ details: { status: "success", provider: "brave_api" } });
	});

	it("网络配置热更新不会合并到旧网络上的同名搜索", async () => {
		const config = defaultWebToolsConfig();
		vi.spyOn(configModule, "loadWebToolsConfig").mockImplementation(async () => structuredClone(config));
		const started = deferredVoid();
		const release = deferredVoid();
		network.fetch.mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return searchResponse("brave_api");
		});
		const runtime = trackRuntime();
		const params = { query: "official pi docs", limit: 1 };
		const first = runtime.search(params, { toolCallId: "old-network" });
		await started.promise;
		config.network.fake_ip_ranges = ["198.18.0.0/16"];
		const second = runtime.search(params, { toolCallId: "new-network" });
		try {
			await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(2));
			const [before, after] = network.fetch.mock.calls.map(([, init]) => init.dispatcher);
			expect(before).not.toBe(after);
		} finally { release.resolve(); }
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});

	it("fetch 分页复用 snapshot，避免重复下载", async () => {
		const config = defaultWebToolsConfig();
		config.webfetch.limits.default_output_chars = 1000;
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockImplementation(async () => httpResponse(200, "x".repeat(2000)));
		const runtime = trackRuntime();
		await expect(runtime.fetch({ url: "https://example.com/a" }, { toolCallId: "first" })).resolves.toMatchObject({ details: { status: "success", snapshot: "created", range: { next_offset: 1000 } } });
		await expect(runtime.fetch({ url: "https://example.com/a", offset: 1000 }, { toolCallId: "next" })).resolves.toMatchObject({ details: { status: "success", snapshot: "hit" } });
		expect(network.fetch).toHaveBeenCalledOnce();
	});

	it("配置错误对 fetch/search 使用一致的结构化失败", async () => {
		await writeFile(path.join(temp.path, "config.jsonc"), "{");
		const runtime = trackRuntime();
		const results = await Promise.all([
			runtime.search({ query: "pi" }, { toolCallId: "search" }),
			runtime.fetch({ url: "https://example.com/" }, { toolCallId: "fetch" }),
		]);
		for (const result of results) {
			expect(result.details).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
			expect(result.content).not.toContain("undefined");
		}
	});
});

function trackRuntime(): WebToolsRuntime {
	const runtime = createWebToolsRuntime();
	runtimes.push(runtime);
	return runtime;
}

function searchResponse(provider: FormalWebSearchProviderId) {
	const results = [{
		title: "Official Pi docs", url: "https://example.com/pi",
		description: "Official Pi documentation and reference.",
		content: "Official Pi documentation and reference.",
	}];
	return httpResponse(200, JSON.stringify(provider === "brave_api" ? { web: { results } } : { results }), { "content-type": "application/json" });
}
