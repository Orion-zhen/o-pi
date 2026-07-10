import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import webTools from "../../agent/extensions/web-tools.js";
import { createWebToolsRuntime } from "../../src/web-tools/web-tools-runtime.js";
import type { WebSearchProvider } from "../../src/web-tools/search-providers/types.js";
import { httpResponse } from "../helpers/http.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
let runtimes: Array<ReturnType<typeof createWebToolsRuntime>> = [];
const temp = useTempDir("o-pi-web-runtime-");
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES");

beforeEach(() => {
	dir = temp.path;
	runtimes = [];
	process.env.PI_WEB_TOOLS_CONFIG = path.join(dir, "missing-config.jsonc");
	process.env.PI_WEB_TOOLS_COOKIES = path.join(dir, "missing-cookies.txt");
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
});

describe("web-tools runtime", () => {
	it("复用搜索结果缓存，并在 close 时释放 provider 与 dispatcher", async () => {
		let calls = 0;
		let providerClosed = 0;
		const provider: WebSearchProvider = {
			id: "exa_mcp",
			async search(params) {
				calls += 1;
				return {
					status: "success",
					provider: "exa_mcp",
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

		const first = await runtime.search({ query: "pi", limit: 1 }, { toolCallId: "search-1" });
		const second = await runtime.search({ query: "pi", limit: 1 }, { toolCallId: "search-2" });

		expect(first.details).toMatchObject({ status: "success", cached: false });
		expect(second.details).toMatchObject({ status: "success", cached: true });
		expect(calls).toBe(1);
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
