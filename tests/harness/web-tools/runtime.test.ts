import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as configModule from "../../../src/harness/web-tools/config.ts";
import type { WebSearchProviderId, WebToolsRuntime } from "../../../src/harness/web-tools/core/types.ts";
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
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES", "BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY", "TINYFISH_API_KEY");

beforeEach(async () => {
	process.env.PI_WEB_TOOLS_CONFIG = path.join(temp.path, "config.jsonc");
	process.env.PI_WEB_TOOLS_COOKIES = path.join(temp.path, "missing-cookies.txt");
	await writeFile(process.env.PI_WEB_TOOLS_CONFIG, JSON.stringify({ websearch: { anysearch: { enabled: false }, exa_mcp: { enabled: false } } }));
	process.env.BRAVE_SEARCH_API_KEY = "test-key";
	delete process.env.EXA_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.TINYFISH_API_KEY;
	network.fetch.mockReset().mockImplementation(async () => httpResponse(200, "hello world", { "content-type": "text/plain" }));
});

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	vi.restoreAllMocks();
});

describe("web-tools runtime", () => {
	it("禁用的提供方不解析命令凭据", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		config.websearch.exa_api.enabled = false;
		const marker = path.join(temp.path, "disabled-credential");
		config.websearch.exa_api.api_key = `!printf unexpected > "${marker}"`;
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockResolvedValue(searchResponse("brave_api"));

		await expect(trackRuntime().search({ query: "pi docs" }, { toolCallId: "disabled-credential" }))
			.resolves.toMatchObject({ details: { status: "success", providers: ["brave_api"] } });
		expect(network.fetch).toHaveBeenCalledOnce();
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("api_key 为空时不创建 provider，引用可用后自动恢复", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		config.websearch.brave_api.api_key = "";
		vi.spyOn(configModule, "loadWebToolsConfig").mockImplementation(async () => structuredClone(config));
		network.fetch.mockImplementation(async () => searchResponse("brave_api"));
		const runtime = trackRuntime();

		await expect(runtime.search({ query: "example", limit: 1 }, { toolCallId: "empty-key" })).resolves.toMatchObject({ details: { status: "failed", error: { code: "NO_PROVIDER_AVAILABLE" }, attempts: [] } });
		expect(network.fetch).not.toHaveBeenCalled();
		config.websearch.brave_api.api_key = "$BRAVE_SEARCH_API_KEY";
		await expect(runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "restored-key" })).resolves.toMatchObject({ details: { providers: ["brave_api"] } });
		expect(network.fetch).toHaveBeenCalledOnce();
	});

	it("固定顺序贯穿真实请求适配，失败和空结果后继续，Tavily 有结果即停止", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.primary_providers = ["brave_api", "exa_api", "tavily", "exa_mcp"];
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		for (const id of ["brave_api", "exa_api", "tavily"] as const) {
			config.websearch[id].enabled = true;
			config.websearch[id].api_key = "test-key";
		}
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockImplementation(async (url) => {
			if (url.toString().startsWith(config.websearch.brave_api.endpoint)) return httpResponse(503, "unavailable");
			if (url.toString().startsWith(config.websearch.exa_api.endpoint)) return httpResponse(200, '{"results":[]}');
			if (url.toString().startsWith(config.websearch.tavily.endpoint)) return searchResponse("tavily");
			throw new Error(`unexpected provider: ${url}`);
		});
		await expect(trackRuntime().search({ query: "research papers about agents", limit: 8 }, { toolCallId: "fixed-order" })).resolves.toMatchObject({
			details: { status: "success", providers: ["tavily"], attempts: [
				{ provider: "brave_api", status: "failed", http_status: 503 },
				{ provider: "exa_api", status: "success", result_count: 0 },
				{ provider: "tavily", status: "success", result_count: 1 },
			] },
		});
		expect(network.fetch).toHaveBeenCalledTimes(3);
	});

	it.each(["not JSON", "null"])("提供方返回损坏响应 %s 时保留解析错误并回退", async (body) => {
		const config = defaultWebToolsConfig();
		config.websearch.primary_providers = ["brave_api", "exa_api", "tavily", "exa_mcp"];
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		config.websearch.exa_api.api_key = "exa-key";
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockImplementation(async (url) => url.hostname === "api.search.brave.com"
			? httpResponse(200, body)
			: searchResponse("exa_api"));
		await expect(trackRuntime().search({ query: "pi docs" }, { toolCallId: "invalid-response" }))
			.resolves.toMatchObject({ details: { status: "success", providers: ["exa_api"], attempts: [
				{ provider: "brave_api", status: "failed", error: { code: "PARSE_FAILED" } },
				{ provider: "exa_api", status: "success" },
			] } });
		expect(network.fetch).toHaveBeenCalledTimes(2);
	});

	it("按配置顺序跳过禁用和缺少凭据的引擎", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		config.websearch.primary_providers = ["tavily", "exa_api", "brave_api", "exa_mcp"];
		config.websearch.tavily.enabled = false;
		config.websearch.tavily.api_key = "available-but-disabled";
		config.websearch.exa_api.api_key = "";
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockResolvedValue(searchResponse("brave_api"));
		await expect(trackRuntime().search({ query: "example", limit: 1 }, { toolCallId: "skip-unavailable" })).resolves.toMatchObject({
			details: { status: "success", providers: ["brave_api"], attempts: [{ provider: "brave_api" }] },
		});
		expect(network.fetch).toHaveBeenCalledOnce();
		expect(network.fetch.mock.calls[0]?.[0].hostname).toBe("api.search.brave.com");
	});

	it("调整顺序不会合并到旧顺序的进行中请求，全部禁用后不发送请求", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.primary_providers = ["brave_api", "exa_api", "tavily", "exa_mcp"];
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
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
			config.websearch.primary_providers = ["exa_api", "brave_api", "tavily", "exa_mcp"];
			await expect(runtime.search(params, { toolCallId: "new-order" })).resolves.toMatchObject({ details: { status: "success", providers: ["exa_api"] } });
		} finally { release.resolve(); }
		await expect(first).resolves.toMatchObject({ details: { status: "success", providers: ["brave_api"] } });
		for (const id of config.websearch.primary_providers) config.websearch[id].enabled = false;
		await expect(runtime.search(params, { toolCallId: "all-disabled" })).resolves.toMatchObject({
			details: { status: "failed", error: { code: "NO_PROVIDER_AVAILABLE" }, attempts: [] },
		});
		expect(network.fetch).toHaveBeenCalledTimes(2);
	});

	it("TinyFish 与主引擎汇总，规范化去重、域名过滤和两层条数限制贯穿真实适配", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		config.websearch.brave_api.max_results = 2;
		config.websearch.tinyfish.api_key = "$TINYFISH_API_KEY";
		config.websearch.tinyfish.max_results = 3;
		process.env.TINYFISH_API_KEY = "tinyfish-key";
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockImplementation(async (url, init) => {
			if (url.hostname === "api.search.brave.com") {
				expect(url.searchParams.get("count")).toBe("2");
				return httpResponse(200, JSON.stringify({ grounding: { generic: [
					{ title: "Primary A", url: "https://example.com/a" },
					{ title: "Primary B", url: "https://example.com/b" },
					{ title: "Primary overflow", url: "https://example.com/primary-overflow" },
				] } }));
			}
			expect(url.hostname).toBe("api.search.tinyfish.ai");
			expect(init.headers["X-API-Key"]).toBe("tinyfish-key");
			expect(url.searchParams.get("include_domains")).toBe("example.com");
			return httpResponse(200, JSON.stringify({ results: [
				{ title: "Excluded", url: "https://excluded.test/" },
				{ title: "Duplicate", url: "https://example.com/b?utm_source=tinyfish#top" },
				{ title: "Aux C", url: "https://example.com/c", snippet: "example snippet" },
				{ title: "Aux D", url: "https://example.com/d" },
				{ title: "Aux overflow", url: "https://example.com/aux-overflow" },
			] }));
		});
		await expect(trackRuntime().search({ query: "site:example.com example", limit: 3 }, { toolCallId: "aggregation" }))
			.resolves.toMatchObject({ details: { status: "success", providers: ["brave_api", "tinyfish"], results: [
				{ rank: 1, title: "Primary A", provider: "brave_api" },
				{ rank: 2, title: "Primary B", provider: "brave_api" },
				{ rank: 3, title: "Aux C", provider: "tinyfish", snippet: "example snippet" },
			], attempts: [{ role: "primary", result_count: 2 }, { role: "auxiliary", result_count: 3 }] } });
		expect(network.fetch).toHaveBeenCalledTimes(2);
	});

	it("TinyFish 凭据热更新隔离同名进行中请求，缺少凭据时跳过辅助请求", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		for (const id of config.websearch.primary_providers) config.websearch[id].enabled = false;
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		const runtime = trackRuntime();
		await expect(runtime.search({ query: "tinyfish" }, { toolCallId: "missing-key" }))
			.resolves.toMatchObject({ details: { error: { code: "NO_PROVIDER_AVAILABLE" }, attempts: [] } });
		expect(network.fetch).not.toHaveBeenCalled();
		const started = deferredVoid();
		const release = deferredVoid();
		network.fetch.mockImplementation(async (_url, init) => {
			if (init.headers["X-API-Key"] === "old-key") { started.resolve(); await release.promise; }
			return searchResponse("tinyfish");
		});
		process.env.TINYFISH_API_KEY = "old-key";
		const first = runtime.search({ query: "tinyfish" }, { toolCallId: "old-tinyfish-key" });
		await started.promise;
		try {
			process.env.TINYFISH_API_KEY = "new-key";
			await expect(runtime.search({ query: "tinyfish" }, { toolCallId: "new-tinyfish-key" }))
				.resolves.toMatchObject({ details: { status: "success", providers: ["tinyfish"] } });
			expect(network.fetch.mock.calls.map(([, init]) => init.headers["X-API-Key"])).toEqual(["old-key", "new-key"]);
		} finally { release.resolve(); }
		await expect(first).resolves.toMatchObject({ details: { status: "success", providers: ["tinyfish"] } });
	});

	it("响应先按域名过滤再截取 limit，不因前排被排除而误判为空", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
		vi.spyOn(configModule, "loadWebToolsConfig").mockResolvedValue(config);
		network.fetch.mockResolvedValue(httpResponse(200, JSON.stringify({ grounding: { generic: [
			{ title: "Excluded", url: "https://example.org/" },
			{ title: "Allowed", url: "https://docs.example.com/" },
		] } })));
		await expect(trackRuntime().search({ query: "site:example.com 文档", limit: 1 }, { toolCallId: "filtered" })).resolves.toMatchObject({
			details: { status: "success", providers: ["brave_api"], results: [{ rank: 1, title: "Allowed", url: "https://docs.example.com/" }] },
		});
		expect(network.fetch).toHaveBeenCalledOnce();
	});

	it("失败请求不污染后续搜索，未调用时不发起网络请求", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
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


	it("并发相同查询合并，不同查询独立请求，完成结果不缓存", async () => {
		const release = deferredVoid();
		network.fetch.mockImplementation(async () => { await release.promise; return searchResponse("brave_api"); });
		const runtime = trackRuntime();
		const firstUpdate = vi.fn();
		const sameUpdate = vi.fn();
		const pending = Promise.all([
			runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "first", onUpdate: firstUpdate }),
			runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "same", onUpdate: sameUpdate }),
			runtime.search({ query: "official pi reference", limit: 1 }, { toolCallId: "different" }),
		]);
		try {
			await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(2));
		} finally { release.resolve(); }
		const results = await pending;
		expect(results.every((result) => result.details.status === "success")).toBe(true);
		for (const onUpdate of [firstUpdate, sameUpdate]) {
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ details: { status: "progress", phase: "parsing" } }));
		}
		expect(network.fetch).toHaveBeenCalledTimes(2);
		await expect(runtime.search({ query: "official pi docs", limit: 1 }, { toolCallId: "again" }))
			.resolves.toMatchObject({ details: { status: "success" } });
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
			await expect(runtime.search(params, { toolCallId: "new-config" })).resolves.toMatchObject({ details: { status: "success", providers: ["brave_api"] } });
			expect(keys).toEqual(["old-key", "new-key"]);
		} finally {
			release.resolve();
		}
		await expect(first).resolves.toMatchObject({ details: { status: "success", providers: ["brave_api"] } });
	});

	it("网络配置热更新不会合并到旧网络上的同名搜索", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
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
		config.websearch.anysearch.enabled = false;
		config.websearch.exa_mcp.enabled = false;
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

function searchResponse(provider: WebSearchProviderId) {
	const results = [{
		title: "Official Pi docs", url: "https://example.com/pi",
		snippets: ["Official Pi documentation and reference."],
		content: "Official Pi documentation and reference.",
	}];
	return httpResponse(200, JSON.stringify(provider === "brave_api" ? { grounding: { generic: results } } : { results }), { "content-type": "application/json" });
}
