import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import webTools, { createWebToolsExtension } from "../../agent/extensions/web-tools.js";
import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import type { WebToolsCapabilityLoaders } from "../../src/web-tools/runtime-types.js";
import { createWebToolsRuntime } from "../../src/web-tools/web-tools-runtime.js";
import type { WebSearchProvider } from "../../src/web-tools/search-providers/types.js";
import { SearchCorpus } from "../../src/web-tools/search-corpus.js";
import type { WebFetchExecutionContext, WebFetchParams, WebSearchParams, WebToolsRuntime } from "../../src/web-tools/types.js";
import { createWebSearchRuntime, type WebSearchProviderLoaders } from "../../src/web-tools/websearch-runtime.js";
import { httpResponse } from "../helpers/http.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const execFileAsync = promisify(execFile);
let dir: string;
let runtimes: Array<ReturnType<typeof createWebToolsRuntime>> = [];
const temp = useTempDir("o-pi-web-runtime-");
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES", "BRAVE_SEARCH_API_KEY", "EXA_API_KEY");

beforeEach(() => {
	dir = temp.path;
	runtimes = [];
	process.env.PI_WEB_TOOLS_CONFIG = path.join(dir, "missing-config.jsonc");
	process.env.PI_WEB_TOOLS_COOKIES = path.join(dir, "missing-cookies.txt");
	delete process.env.BRAVE_SEARCH_API_KEY;
});

afterEach(async () => {
	await Promise.all(runtimes.map((runtime) => runtime.close()));
});

describe("web-tools extension", () => {
	it("按顺序注册 websearch、webfetch 工具、schema 和错误标记事件", async () => {
		const registered: unknown[] = [];
		const handlers = new Map<string, Function>();
		const pi = {
			registerTool(tool: unknown) {
				registered.push(tool);
			},
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
		};
		webTools(pi as unknown as ExtensionAPI);
		const searchTool = registered[0] as {
			name: string;
			parameters: { properties: Record<string, unknown> };
		};
		const fetchTool = registered[1] as {
			name: string;
			parameters: { properties: Record<string, unknown> };
		};
		expect(searchTool.name).toBe("websearch");
		expect(fetchTool.name).toBe("webfetch");
		expect(Object.keys(searchTool.parameters.properties)).toEqual(["query", "limit"]);
		expect(Object.keys(fetchTool.parameters.properties)).toEqual(["url", "mode", "offset", "limit"]);
		expect(fetchTool.parameters.properties["mode"]).toMatchObject({
			type: "string",
			enum: ["readable", "source"],
		});

		const eventResult = handlers.get("tool_result")?.({
			toolName: "webfetch",
			details: { status: "failed", error: { code: "INVALID_URL", message: "bad" } },
		});
		expect(eventResult).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({
			toolName: "websearch",
			details: { status: "failed", provider: "duckduckgo_html", error: { code: "PROVIDER_BLOCKED", message: "blocked" } },
		})).toEqual({ isError: true });
		await handlers.get("session_shutdown")?.({});
	});

	it("注册和 session_start 不加载 runtime，并让并发首次执行和 shutdown 复用同一结果", async () => {
		const registered: Array<{ name: string; execute: Function }> = [];
		const handlers = new Map<string, Function>();
		let resolveRuntime: ((runtime: WebToolsRuntime) => void) | undefined;
		const pendingRuntime = new Promise<WebToolsRuntime>((resolve) => {
			resolveRuntime = resolve;
		});
		const close = vi.fn(async () => undefined);
		const runtime: WebToolsRuntime = {
			async search() {
				return {
					content: "search",
					details: {
						status: "success",
						query: "pi",
						provider: "exa_api",
						results: [],
						cached: false,
						downloaded_bytes: 0,
						duration_ms: 0,
						attempts: [],
					},
				};
			},
			async fetch() {
				return {
					content: "fetch",
					details: { status: "failed", error: { code: "INVALID_URL", message: "bad" } },
				};
			},
			close,
		};
		const loadRuntime = vi.fn(() => pendingRuntime);
		const extension = createWebToolsExtension(loadRuntime);
		const pi = {
			registerTool(tool: unknown) {
				registered.push(tool as { name: string; execute: Function });
			},
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
		};
		extension(pi as ExtensionAPI);

		expect(handlers.has("session_start")).toBe(false);
		expect(handlers.has("session_shutdown")).toBe(true);
		expect(loadRuntime).not.toHaveBeenCalled();
		const search = registered.find((tool) => tool.name === "websearch");
		const fetch = registered.find((tool) => tool.name === "webfetch");
		if (search === undefined) throw new Error("missing websearch");
		if (fetch === undefined) throw new Error("missing webfetch");
		const searchExecution = search.execute("search-1", { query: "pi" }, undefined, undefined, {});
		const fetchExecution = fetch.execute("fetch-1", { url: "https://example.com/" }, undefined, undefined, { hasUI: false });
		expect(loadRuntime).toHaveBeenCalledTimes(1);
		if (resolveRuntime === undefined) throw new Error("missing runtime resolver");
		resolveRuntime(runtime);
		await expect(searchExecution).resolves.toMatchObject({ content: [{ type: "text", text: "search" }] });
		await expect(fetchExecution).resolves.toMatchObject({ content: [{ type: "text", text: "fetch" }] });
		await handlers.get("session_shutdown")?.({});
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("只在模型和 API 都支持工具图片时返回 Pi ImageContent", async () => {
		const registered: Array<{ name: string; execute: Function }> = [];
		const fetch = vi.fn(async (_params: WebFetchParams, _context: WebFetchExecutionContext) => ({
			content: "page",
			details: {
				status: "success" as const,
				scope: "static_response" as const,
				page_kind: "image" as const,
				text_source: "metadata" as const,
				completeness: "complete" as const,
				omissions: [],
				requested_url: "https://example.com/",
				final_url: "https://example.com/",
				http_status: 200,
				format: "markdown" as const,
				downloaded_bytes: 10,
				total_chars: 4,
				range: { start: 0, end: 4, total: 4, has_more: false },
				authenticated: false,
				redirect_count: 0,
				snapshot: "not_needed" as const,
				deferred_fragments: { discovered: 0, resolved: 0 },
				media: { discovered: 1, returned: 1 },
				duration_ms: 1,
				preview: "page",
			},
			media: [{ data: Uint8Array.from([1, 2, 3]), mimeType: "image/png", sourceUrl: "https://example.com/image.png" }],
		}));
		const runtime: WebToolsRuntime = {
			fetch,
			async search() {
				return {
					content: "search",
					details: {
						status: "success",
						query: "q",
						provider: "exa_api",
						results: [],
						cached: false,
						downloaded_bytes: 0,
						duration_ms: 0,
						attempts: [],
					},
				};
			},
			async close() {},
		};
		createWebToolsExtension(async () => runtime)({
			registerTool(tool: unknown) {
				registered.push(tool as { name: string; execute: Function });
			},
			on() {},
		} as unknown as ExtensionAPI);
		const tool = registered.find((item) => item.name === "webfetch");
		if (tool === undefined) throw new Error("missing webfetch");
		const responsesResult = await tool.execute(
			"fetch-responses-image",
			{ url: "https://example.com/" },
			undefined,
			undefined,
			{ hasUI: false, model: { api: "openai-responses", input: ["text", "image"] } },
		);
		expect(fetch).toHaveBeenCalledWith(
			{ url: "https://example.com/" },
			expect.objectContaining({ acceptsImages: true }),
		);
		expect(responsesResult.content).toEqual([
			{ type: "text", text: "page" },
			{ type: "image", data: "AQID", mimeType: "image/png" },
		]);

		const completionsResult = await tool.execute(
			"fetch-completions-image",
			{ url: "https://example.com/" },
			undefined,
			undefined,
			{ hasUI: false, model: { api: "openai-completions", input: ["text", "image"] } },
		);
		expect(fetch).toHaveBeenLastCalledWith(
			{ url: "https://example.com/" },
			expect.objectContaining({
				acceptsImages: false,
				imageOmissionReason: "api_no_tool_image_output",
			}),
		);
		expect(completionsResult.content).toEqual([{ type: "text", text: "page" }]);
	});

	it("通过 Pi 的 Jiti 加载后首次调用可正常读取配置", async () => {
		const extensionPath = path.join(process.cwd(), "agent/extensions/web-tools.ts");
		const invalidConfigPath = path.join(process.cwd(), "package.json");
		const script = `
			import { createJiti } from "jiti/static";
			const jiti = createJiti(import.meta.url, { moduleCache: false });
			const extension = await jiti.import(${JSON.stringify(extensionPath)}, { default: true });
			const tools = [];
			const handlers = new Map();
			extension({
				registerTool(tool) { tools.push(tool); },
				on(name, handler) { handlers.set(name, handler); },
			});
			const search = tools.find((tool) => tool.name === "websearch");
			if (search === undefined) throw new Error("missing websearch");
			const result = await search.execute("jiti-search", { query: "pi" }, undefined, undefined, {});
			console.log(result.content[0].text);
			await handlers.get("session_shutdown")?.({});
		`;

		const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: process.cwd(),
			env: { ...process.env, PI_WEB_TOOLS_CONFIG: invalidConfigPath },
		});

		expect(stdout).toContain("web-tools config does not match schema.");
		expect(stdout).not.toContain("agentConfigPath");
	});
});

describe("web-tools runtime", () => {
	it("api_key 为空时不加载 provider，引用可用后自动恢复", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.brave_api.api_key = "";
		config.websearch.exa_api.enabled = false;
		config.websearch.tavily.enabled = false;
		const providerLoaders: WebSearchProviderLoaders = {
			brave: vi.fn(async () => ({
				id: "brave_api" as const,
				async search(params: WebSearchParams) {
					return {
						status: "success" as const,
						provider: "brave_api" as const,
						downloadedBytes: 0,
						results: Array.from({ length: 3 }, (_, index) => ({
							rank: index + 1,
							title: `${params.query} ${index}`,
							url: `https://site${index}.test/result`,
							snippet: `${params.query} documentation result`,
						})),
					};
				},
			})),
			exa: vi.fn(async () => { throw new Error("disabled Exa provider loaded"); }),
			tavily: vi.fn(async () => { throw new Error("disabled Tavily provider loaded"); }),
			duckDuckGo: vi.fn(async () => ({
				id: "duckduckgo_html" as const,
				async search(params: WebSearchParams) {
					return { status: "success" as const, provider: "duckduckgo_html" as const, downloadedBytes: 0, results: [{ rank: 1, title: params.query, url: "https://fallback.test/" }] };
				},
			})),
		};
		const runtime = createWebSearchRuntime({
			getDispatcher: async () => new Agent(),
			fetchImpl: async () => { throw new Error("unused fetch"); },
			loadConfig: async () => structuredClone(config),
			now: () => 100,
			setAllowedFakeIpRanges() {},
			searchCorpus: new SearchCorpus(() => 100),
		}, providerLoaders);

		await expect(runtime.search({ query: "empty key fallback" }, { toolCallId: "search-empty" })).resolves.toMatchObject({ details: { provider: "duckduckgo_html" } });
		expect(providerLoaders.brave).not.toHaveBeenCalled();

		config.websearch.brave_api.api_key = "$BRAVE_SEARCH_API_KEY";
		process.env.BRAVE_SEARCH_API_KEY = "available-key";
		await expect(runtime.search({ query: "official brave docs" }, { toolCallId: "search-restored" })).resolves.toMatchObject({ details: { provider: "brave_api" } });
		expect(providerLoaders.brave).toHaveBeenCalledTimes(1);
		expect(providerLoaders.duckDuckGo).toHaveBeenCalledTimes(1);
		await runtime.close();
	});

	it("默认搜索 provider 只在实际命中时加载，失败可重试并在会话内复用", async () => {
		const config = defaultWebToolsConfig();
		config.websearch.brave_api.enabled = false;
		config.websearch.tavily.enabled = false;
		process.env.EXA_API_KEY = "test-key";
		const closeExa = vi.fn(async () => undefined);
		let exaLoadAttempts = 0;
		const providerLoaders: WebSearchProviderLoaders = {
			brave: vi.fn(async () => { throw new Error("unused Brave provider"); }),
			exa: vi.fn(async () => {
				exaLoadAttempts += 1;
				if (exaLoadAttempts === 1) throw new Error("simulated provider import failure");
				return {
					id: "exa_api" as const,
					async search(params: WebSearchParams) {
						return {
							status: "success" as const,
							provider: "exa_api" as const,
							downloadedBytes: 0,
							results: [{ rank: 1, title: params.query, url: "https://example.com/" }],
						};
					},
					close: closeExa,
				};
			}),
			tavily: vi.fn(async () => { throw new Error("unused Tavily provider"); }),
			duckDuckGo: vi.fn(async () => {
				throw new Error("unused DuckDuckGo provider");
			}),
		};
		const runtime = createWebSearchRuntime({
			getDispatcher: async () => new Agent(),
			fetchImpl: async () => {
				throw new Error("unused fetch");
			},
			loadConfig: async () => structuredClone(config),
			now: () => 100,
			setAllowedFakeIpRanges() {},
			searchCorpus: new SearchCorpus(() => 100),
		}, providerLoaders);

		await expect(runtime.search({ query: "research paper first" }, { toolCallId: "search-1" })).rejects.toThrow("simulated provider import failure");
		await runtime.search({ query: "research paper second" }, { toolCallId: "search-2" });
		await runtime.search({ query: "research paper third" }, { toolCallId: "search-3" });
		expect(providerLoaders.exa).toHaveBeenCalledTimes(2);
		expect(providerLoaders.duckDuckGo).not.toHaveBeenCalled();
		await runtime.close();
		expect(closeExa).toHaveBeenCalledTimes(1);
	});

	it("按调用能力分别加载 search/fetch，并让共享资源只关闭一次", async () => {
		const dispatcher = new Agent();
		const closeDispatcher = vi.spyOn(dispatcher, "close");
		const closeSearch = vi.fn(async () => undefined);
		const closeFetch = vi.fn(async () => undefined);
		const loaders: WebToolsCapabilityLoaders = {
			search: vi.fn(async () => ({
				async search(params: WebSearchParams) {
					return {
						content: params.query,
						details: {
							status: "success" as const,
							query: params.query,
							provider: "exa_api" as const,
							results: [],
							cached: false,
							downloaded_bytes: 0,
							duration_ms: 0,
							attempts: [],
						},
					};
				},
				close: closeSearch,
			})),
			fetch: vi.fn(async () => ({
				async fetch() {
					return { content: "fetch", details: { status: "failed" as const, error: { code: "INVALID_URL" as const, message: "bad" } } };
				},
				close: closeFetch,
			})),
		};
		const runtime = trackRuntime(createWebToolsRuntime({ dispatcher }, loaders));

		expect(loaders.search).not.toHaveBeenCalled();
		expect(loaders.fetch).not.toHaveBeenCalled();
		await runtime.search({ query: "pi" }, { toolCallId: "search-1" });
		expect(loaders.search).toHaveBeenCalledTimes(1);
		expect(loaders.fetch).not.toHaveBeenCalled();
		await runtime.search({ query: "cached loader" }, { toolCallId: "search-2" });
		expect(loaders.search).toHaveBeenCalledTimes(1);
		await runtime.fetch({ url: "bad" }, { toolCallId: "fetch-1", hasUI: false });
		expect(loaders.fetch).toHaveBeenCalledTimes(1);

		await closeRuntime(runtime);
		expect(closeSearch).toHaveBeenCalledTimes(1);
		expect(closeFetch).toHaveBeenCalledTimes(1);
		expect(closeDispatcher).toHaveBeenCalled();
	});

	it("capability 加载失败后允许重试，shutdown 不加载未使用能力", async () => {
		const dispatcher = new Agent();
		let attempts = 0;
		const loaders: WebToolsCapabilityLoaders = {
			async search() {
				attempts += 1;
				if (attempts === 1) throw new Error("simulated search import failure");
				return {
					async search() {
						return {
							content: "ok",
							details: {
								status: "success" as const,
								query: "pi",
								provider: "exa_api" as const,
								results: [],
								cached: false,
								downloaded_bytes: 0,
								duration_ms: 0,
								attempts: [],
							},
						};
					},
					async close() {},
				};
			},
			fetch: vi.fn(async () => {
				throw new Error("unused fetch loader");
			}),
		};
		const runtime = trackRuntime(createWebToolsRuntime({ dispatcher }, loaders));

		await expect(runtime.search({ query: "pi" }, { toolCallId: "search-1" })).rejects.toThrow("simulated search import failure");
		await expect(runtime.search({ query: "pi" }, { toolCallId: "search-2" })).resolves.toMatchObject({ content: "ok" });
		expect(attempts).toBe(2);
		await closeRuntime(runtime);
		expect(loaders.fetch).not.toHaveBeenCalled();
	});

	it("并发初始化只创建一个 router，复用搜索缓存并在 close 时释放一次资源", async () => {
		let calls = 0;
		let providerClosed = 0;
		const provider: WebSearchProvider = {
			id: "exa_api",
			async search(params) {
				calls += 1;
				return {
					status: "success",
					provider: "exa_api",
					downloadedBytes: 12,
					results: [{ rank: 1, title: params.query, url: "https://example.com/" }],
				};
			},
			async close() {
				providerClosed += 1;
			},
		};
		const dispatcher = new Agent();
		const closeDispatcher = vi.spyOn(dispatcher, "close");
		const runtime = trackRuntime(createWebToolsRuntime({ dispatcher, searchProviders: [provider], now: () => 100 }));

		const [first, concurrent] = await Promise.all([
			runtime.search({ query: "pi", limit: 1 }, { toolCallId: "search-1" }),
			runtime.search({ query: "concurrent", limit: 1 }, { toolCallId: "search-2" }),
		]);
		const second = await runtime.search({ query: "pi", limit: 1 }, { toolCallId: "search-3" });

		expect(first.details).toMatchObject({ status: "success", cached: false });
		expect(concurrent.details).toMatchObject({ status: "success", cached: false });
		expect(second.details).toMatchObject({ status: "success", cached: true });
		expect(calls).toBe(2);
		await closeRuntime(runtime);
		expect(providerClosed).toBe(1);
		expect(closeDispatcher).toHaveBeenCalled();
	});

	it("fetch 分页复用 snapshot，避免重复下载", async () => {
		let requests = 0;
		const dispatcher = new Agent();
		const runtime = trackRuntime(createWebToolsRuntime({
			dispatcher,
			fetchImpl: async () => {
				requests += 1;
				return httpResponse(200, "hello world", { "content-type": "text/plain; charset=utf-8" });
			},
			now: () => 100,
		}));

		const first = await runtime.fetch({ url: "https://example.com/a", limit: 5 }, { toolCallId: "fetch-1", hasUI: false });
		const second = await runtime.fetch({ url: "https://example.com/a", offset: 5, limit: 6 }, { toolCallId: "fetch-2", hasUI: false });

		expect(first.details).toMatchObject({ status: "success", snapshot: "created" });
		expect(second.details).toMatchObject({ status: "success", snapshot: "hit" });
		expect(requests).toBe(1);
		await closeRuntime(runtime);
	});

	it("配置错误对 fetch/search 使用一致的结构化失败", async () => {
		await writeFile(process.env.PI_WEB_TOOLS_CONFIG!, "{");
		const runtime = trackRuntime(createWebToolsRuntime({ dispatcher: new Agent() }));

		const [search, fetch] = await Promise.all([
			runtime.search({ query: "pi" }, { toolCallId: "search" }),
			runtime.fetch({ url: "https://example.com/" }, { toolCallId: "fetch", hasUI: false }),
		]);

		expect(search.details).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
		expect(fetch.details).toMatchObject({ status: "failed", error: { code: "CONFIG_ERROR" } });
		expect(search.content).not.toContain("undefined");
		expect(fetch.content).not.toContain("undefined");
		await closeRuntime(runtime);
	});
});

function trackRuntime(runtime: ReturnType<typeof createWebToolsRuntime>): ReturnType<typeof createWebToolsRuntime> {
	runtimes.push(runtime);
	return runtime;
}

async function closeRuntime(runtime: ReturnType<typeof createWebToolsRuntime>): Promise<void> {
	await runtime.close();
	runtimes = runtimes.filter((candidate) => candidate !== runtime);
}
