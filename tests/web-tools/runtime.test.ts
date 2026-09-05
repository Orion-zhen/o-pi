import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as configModule from "../../src/web-tools/config.js";
import * as fetchModule from "../../src/web-tools/fetch/webfetch-runtime.js";
import * as searchModule from "../../src/web-tools/search/websearch-runtime.js";
import * as apiModule from "../../src/web-tools/search-providers/api-provider.js";
import * as ddgModule from "../../src/web-tools/search-providers/duckduckgo-html-provider.js";
import type { FormalWebSearchProviderId, WebHttpFetch, WebToolsRuntime } from "../../src/web-tools/core/types.js";
import { createWebToolsRuntime } from "../../src/web-tools/web-tools-runtime.js";
import { defaultWebToolsConfig } from "./config-fixture.js";
import { deferredVoid } from "../helpers/async.js";
import { httpResponse } from "../helpers/http.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const network = vi.hoisted(() => ({ fetch: vi.fn<WebHttpFetch>() }));
vi.mock("undici", async (importOriginal) => ({
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
		const createApi = vi.spyOn(apiModule, "createApiSearchProvider");
		const createDdg = vi.spyOn(ddgModule, "createDuckDuckGoHtmlProvider");
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
		const createApi = vi.spyOn(apiModule, "createApiSearchProvider");
		const createDdg = vi.spyOn(ddgModule, "createDuckDuckGoHtmlProvider");
		network.fetch.mockImplementation(async () => searchResponse(selected));
		await expect(trackRuntime().search({ query: "official pi docs", limit: 1 }, { toolCallId: selected })).resolves.toMatchObject({ details: { status: "success", provider: selected } });
		expect(createApi).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: selected }));
		expect(createDdg).not.toHaveBeenCalled();
	});

	it("提供方只在实际命中时创建，初始化失败在会话内复用", async () => {
		const createApi = vi.spyOn(apiModule, "createApiSearchProvider").mockImplementation(() => {
			throw new Error("provider initialization failed");
		});
		const createDdg = vi.spyOn(ddgModule, "createDuckDuckGoHtmlProvider");
		const runtime = trackRuntime();
		expect(createApi).not.toHaveBeenCalled();
		await expect(runtime.search({ query: "first" }, { toolCallId: "first" })).rejects.toThrow("provider initialization failed");
		await expect(runtime.search({ query: "second" }, { toolCallId: "second" })).rejects.toThrow("provider initialization failed");
		expect(createApi).toHaveBeenCalledOnce();
		expect(createDdg).not.toHaveBeenCalled();
	});

	it("按调用能力分别创建 search/fetch，共享资源只关闭一次", async () => {
		const createSearch = vi.spyOn(searchModule, "createWebSearchRuntime");
		const createFetch = vi.spyOn(fetchModule, "createWebFetchRuntime");
		network.fetch.mockImplementation(async (url) => url.hostname === "api.search.brave.com"
			? searchResponse("brave_api")
			: httpResponse(200, "page", { "content-type": "text/plain" }));
		const runtime = trackRuntime();
		expect(createSearch).not.toHaveBeenCalled();
		expect(createFetch).not.toHaveBeenCalled();
		await runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "search-1" });
		expect(createSearch).toHaveBeenCalledOnce();
		expect(createFetch).not.toHaveBeenCalled();
		await runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "search-2" });
		await runtime.fetch({ url: "https://example.com/" }, { toolCallId: "fetch" });
		expect(createSearch).toHaveBeenCalledOnce();
		expect(createFetch).toHaveBeenCalledOnce();
		const search = createSearch.mock.results[0]?.value;
		const fetch = createFetch.mock.results[0]?.value;
		if (search === undefined || fetch === undefined) throw new Error("missing capabilities");
		const closeSearch = vi.spyOn(search, "close");
		const closeFetch = vi.spyOn(fetch, "close");
		const dispatchers = network.fetch.mock.calls.map(([, init]) => init.dispatcher);
		expect(new Set(dispatchers).size).toBe(1);
		const dispatcher = dispatchers[0];
		if (dispatcher === undefined) throw new Error("missing dispatcher");
		const closeDispatcher = vi.spyOn(dispatcher, "close");
		const closing = runtime.close();
		expect(runtime.close()).toBe(closing);
		await closing;
		expect(closeSearch).toHaveBeenCalledOnce();
		expect(closeFetch).toHaveBeenCalledOnce();
		expect(closeDispatcher.mock.calls.filter((args) => args.length === 0)).toHaveLength(1);
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
			expect(() => runtime.fetch({ url: "https://example.com/" }, { toolCallId: "late" })).toThrow("runtime is closed");
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

	it("能力初始化失败在会话内复用，shutdown 不加载未使用能力", async () => {
		const createSearch = vi.spyOn(searchModule, "createWebSearchRuntime").mockImplementation(() => {
			throw new Error("search initialization failed");
		});
		const createFetch = vi.spyOn(fetchModule, "createWebFetchRuntime");
		const runtime = trackRuntime();
		await expect(runtime.search({ query: "pi" }, { toolCallId: "first" })).rejects.toThrow("search initialization failed");
		await expect(runtime.search({ query: "pi" }, { toolCallId: "second" })).rejects.toThrow("search initialization failed");
		await runtime.close();
		expect(createSearch).toHaveBeenCalledOnce();
		expect(createFetch).not.toHaveBeenCalled();
		expect(network.fetch).not.toHaveBeenCalled();
	});

	it("并发搜索复用提供方，完成后的相同查询重新请求", async () => {
		const createApi = vi.spyOn(apiModule, "createApiSearchProvider");
		network.fetch.mockImplementation(async () => searchResponse("brave_api"));
		const runtime = trackRuntime();
		const results = await Promise.all([
			runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "first" }),
			runtime.search({ query: "official pi reference", limit: 1 }, { toolCallId: "concurrent" }),
		]);
		results.push(await runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "again" }));
		expect(results.every((result) => result.details.status === "success")).toBe(true);
		expect(createApi).toHaveBeenCalledOnce();
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

	it("fetch 分页复用 snapshot，避免重复下载", async () => {
		const runtime = trackRuntime();
		await expect(runtime.fetch({ url: "https://example.com/a", limit: 5 }, { toolCallId: "first" })).resolves.toMatchObject({ details: { status: "success", snapshot: "created" } });
		await expect(runtime.fetch({ url: "https://example.com/a", offset: 5, limit: 6 }, { toolCallId: "next" })).resolves.toMatchObject({ details: { status: "success", snapshot: "hit" } });
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
