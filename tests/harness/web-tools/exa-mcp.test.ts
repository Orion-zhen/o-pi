import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebSearchRuntime } from "../../../src/harness/web-tools/search/websearch-runtime.ts";
import type { WebSearchCapability } from "../../../src/harness/web-tools/core/runtime-types.ts";
import type { WebHttpFetch, WebHttpResponse } from "../../../src/harness/web-tools/network/types.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { httpResponse } from "../../helpers/http.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { preserveEnv } from "../../helpers/lifecycle.ts";

preserveEnv("BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY", "TINYFISH_API_KEY", "ANYSEARCH_API_KEY");
let config: ReturnType<typeof defaultWebToolsConfig>;
let dispatcher: Agent;
let runtime: WebSearchCapability;
let format: "json" | "sse";
const fetchImpl = vi.fn<WebHttpFetch>();
const rows = [{ title: "Pi docs", url: "https://example.com/docs?utm_source=exa#top", highlights: ["Pi reference"] }];
let callResponse: () => Promise<WebHttpResponse>;

function rpc(id: unknown, result: unknown): WebHttpResponse {
	const json = JSON.stringify({ jsonrpc: "2.0", id, result });
	return httpResponse(200, format === "sse" ? `event: message\ndata: ${json}\n\n` : json, {
		"content-type": format === "sse" ? "text/event-stream" : "application/json",
		"mcp-session-id": "test-session",
	});
}
function toolResult(content: unknown, isError = false): WebHttpResponse {
	return rpc(1, { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }], isError });
}

beforeEach(() => {
	for (const name of ["BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY", "TINYFISH_API_KEY", "ANYSEARCH_API_KEY"]) delete process.env[name];
	config = defaultWebToolsConfig();
	config.websearch.anysearch.enabled = false;
	format = "sse";
	dispatcher = new Agent();
	callResponse = async () => toolResult({ results: rows });
	fetchImpl.mockReset().mockImplementation(async (_url, init) => {
		if (init.method === "DELETE") return httpResponse(204, "");
		if (init.method === "GET") return httpResponse(405, "");
		const request = JSON.parse(init.body ?? "null");
		if (request.method === "initialize") return rpc(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "exa", version: "test" } });
		if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return httpResponse(202, "");
		if (request.method === "tools/call") return callResponse();
		throw new Error(`unexpected request: ${init.body}`);
	});
	runtime = createWebSearchRuntime({ loadConfig: async () => structuredClone(config), getDispatcher: async () => dispatcher, fetchImpl, now: Date.now });
});
afterEach(async () => { await runtime.close(); await dispatcher.close(); });

function search(signal?: AbortSignal) {
	return runtime.search({ query: "site:example.com Pi", limit: 2 }, { toolCallId: "exa-mcp", ...(signal === undefined ? {} : { signal }) });
}
function calls(method: string) {
	return fetchImpl.mock.calls.filter(([, init]) => init.method === "POST" && JSON.parse(init.body ?? "null").method === method);
}

describe("Exa MCP 免 key 搜索", () => {
	it.each(["json", "sse"] as const)("零 API key 时通过 SDK 处理 %s 响应，沿用域名过滤和结果规范化", async (responseFormat) => {
		format = responseFormat;
		callResponse = async () => toolResult({ results: [
			{ title: "Excluded", url: "https://outside.test/" }, ...rows,
			{ title: "Duplicate", url: "https://example.com/docs" },
			{ title: "Fallback text", url: "https://example.com/extra", text: "Pi extra" },
			{ title: "Overflow", url: "https://example.com/overflow" },
		] });
		await expect(search()).resolves.toMatchObject({ details: { status: "success", providers: ["exa_mcp"], results: [
			{ rank: 1, provider: "exa_mcp", url: "https://example.com/docs", snippet: "Pi reference" },
			{ rank: 2, provider: "exa_mcp", url: "https://example.com/extra", snippet: "Pi extra" },
		], attempts: [{ provider: "exa_mcp", role: "primary", status: "success", result_count: 2 }] } });
		const request = calls("tools/call")[0];
		expect(request?.[0].toString()).toBe("https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
		expect(JSON.parse(request?.[1].body ?? "null").params).toEqual({ name: "web_search_advanced_exa", arguments: {
			query: "Pi", numResults: 2, type: "auto", includeDomains: ["example.com"], excludeDomains: ["csdn.com", "gitcode.com"],
			textMaxCharacters: 600, enableHighlights: true, highlightsMaxCharacters: 600,
		} });
		for (const [, init] of fetchImpl.mock.calls) {
			expect(init.dispatcher).toBe(dispatcher);
			expect(init.redirect).toBe("manual");
			expect(init.headers).not.toHaveProperty("authorization");
			expect(init.headers).not.toHaveProperty("x-api-key");
		}
		expect(request?.[1].headers["mcp-session-id"]).toBe("test-session");
		expect(fetchImpl.mock.calls.some(([, init]) => init.method === "DELETE" && init.headers["mcp-session-id"] === "test-session")).toBe(true);
		expect(calls("tools/list")).toHaveLength(0);
	});

	it("前序主引擎失败或空结果后才回退到 MCP，主结果成功则不连接 MCP", async () => {
		for (const id of ["brave_api", "exa_api", "tavily"] as const) config.websearch[id].api_key = "test-key";
		const mcpFetch = fetchImpl.getMockImplementation();
		if (mcpFetch === undefined) throw new Error("missing HTTP boundary");
		fetchImpl.mockImplementation(async (url, init) => {
			if (url.hostname === "mcp.exa.ai") return mcpFetch(url, init);
			return url.hostname === "api.search.brave.com" ? httpResponse(503, "unavailable") : httpResponse(200, '{"results":[]}');
		});
		await expect(search()).resolves.toMatchObject({ details: { providers: ["exa_mcp"], attempts: [
			{ provider: "brave_api", status: "failed" }, { provider: "exa_api", result_count: 0 },
			{ provider: "tavily", result_count: 0 }, { provider: "exa_mcp", status: "success" },
		] } });
		fetchImpl.mockClear().mockImplementation(async () => httpResponse(200, JSON.stringify({ web: { results: rows } })));
		await expect(search()).resolves.toMatchObject({ details: { providers: ["brave_api"] } });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("禁用 MCP 后，缺少凭据时不请求网络", async () => {
		config.websearch.exa_mcp.enabled = false;
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "NO_PROVIDER_AVAILABLE" }, attempts: [] } });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		[429, "limited", "RATE_LIMITED"], [402, "quota exhausted", "QUOTA_EXHAUSTED"],
		[503, "unavailable", "HTTP_ERROR"], [307, "redirect", "CONFIG_ERROR"],
	] as const)("HTTP %i 映射为 %s，不重试或跟随重定向", async (status, body, code) => {
		callResponse = async () => httpResponse(status, body, { location: "https://outside.test/mcp" });
		await expect(search()).resolves.toMatchObject({ details: { error: { code }, http_status: status } });
		expect(calls("tools/call")).toHaveLength(1);
		expect(fetchImpl.mock.calls.every(([url]) => url.hostname === "mcp.exa.ai")).toBe(true);
	});

	it.each([
		["You've hit Exa's free MCP rate limit.", "RATE_LIMITED"],
		["web_search_advanced_exa error (402): quota exhausted", "QUOTA_EXHAUSTED"],
		["web_search_advanced_exa error: failed", "HTTP_ERROR"],
	] as const)("MCP 工具错误 %s 不当作搜索结果", async (text, code) => {
		callResponse = async () => toolResult(text, true);
		await expect(search()).resolves.toMatchObject({ details: { error: { code } } });
		expect(calls("tools/call")).toHaveLength(1);
	});

	it.each(["not JSON", '{"results":{}}', '{}'])("非法结果 %s 明确报解析失败", async (content) => {
		callResponse = async () => toolResult(content);
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "PARSE_FAILED" } } });
	});

	it.each(["json", "sse"] as const)("%s 协议响应损坏时立即失败，不等待超时", async (responseFormat) => {
		format = responseFormat;
		callResponse = async () => httpResponse(200, format === "sse" ? "event: message\ndata: invalid\n\n" : "invalid", { "content-type": format === "sse" ? "text/event-stream" : "application/json" });
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "PARSE_FAILED" } } });
	});

	it("MCP JSON-RPC 错误和错误内容类型沿用公开错误结构", async () => {
		callResponse = async () => httpResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown tool" } }), { "content-type": "application/json" });
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "CONFIG_ERROR" } } });
		callResponse = async () => httpResponse(200, "plain text");
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "UNSUPPORTED_CONTENT_TYPE" } } });
	});

	it.each(["header", "stream"] as const)("%s 超过响应上限会取消正文并保留 RESPONSE_TOO_LARGE", async (source) => {
		config.websearch.exa_mcp.response_bytes = 65536;
		const cancel = vi.fn(async () => undefined);
		callResponse = async () => {
			const response = httpResponse(200, "x".repeat(65537), { "content-type": "text/event-stream", ...(source === "header" ? { "content-length": "65537" } : {}) });
			if (response.body === null) throw new Error("missing body");
			const reader = response.body.getReader();
			return { ...response, body: { getReader: () => ({ ...reader, cancel }), cancel } };
		};
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "RESPONSE_TOO_LARGE" } } });
		expect(cancel).toHaveBeenCalled();
	});

	it.each(["provider", "total"] as const)("初始化和搜索共用 %s 超时预算", async (budget) => {
		if (budget === "provider") config.websearch.exa_mcp.timeout_seconds = 1;
		else config.websearch.total_deadline_seconds = 1;
		const original = fetchImpl.getMockImplementation();
		if (original === undefined) throw new Error("missing HTTP boundary");
		fetchImpl.mockImplementation(async (url, init) => {
			if (init.method === "POST" && JSON.parse(init.body ?? "null").method === "initialize") await new Promise((resolve) => setTimeout(resolve, 650));
			if (init.method === "POST" && JSON.parse(init.body ?? "null").method === "tools/call") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
			return original(url, init);
		});
		const started = Date.now();
		await expect(search()).resolves.toMatchObject({ details: { error: { code: "TIMEOUT" } } });
		expect(Date.now() - started).toBeLessThan(1400);
		expect(calls("tools/call")).toHaveLength(1);
	});

	it("用户取消中止请求，仍尝试终止会话", async () => {
		const started = deferredVoid();
		callResponse = () => {
			started.resolve();
			return new Promise((_, reject) => {
				const signal = calls("tools/call")[0]?.[1].signal;
				if (signal === undefined) throw new Error("missing signal");
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};
		const controller = new AbortController();
		const pending = search(controller.signal);
		await started.promise;
		controller.abort();
		await expect(pending).resolves.toMatchObject({ details: { error: { code: "ABORTED" } } });
		expect(fetchImpl.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(true);
	});

	it("结束搜索会取消 SDK 的后台 SSE 流，不重连", async () => {
		const original = fetchImpl.getMockImplementation();
		if (original === undefined) throw new Error("missing HTTP boundary");
		const cancel = vi.fn(async () => undefined);
		fetchImpl.mockImplementation(async (url, init) => init.method === "GET" ? {
			...httpResponse(200, "", { "content-type": "text/event-stream" }),
			body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel }), cancel },
		} : original(url, init));
		await expect(search()).resolves.toMatchObject({ details: { status: "success" } });
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetchImpl.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(1);
	});

	it("会话终止超时最多等待一秒，仍返回成功结果", async () => {
		const original = fetchImpl.getMockImplementation();
		if (original === undefined) throw new Error("missing HTTP boundary");
		fetchImpl.mockImplementation(async (url, init) => init.method === "DELETE"
			? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
			: original(url, init));
		const started = Date.now();
		await expect(search()).resolves.toMatchObject({ details: { status: "success" } });
		expect(Date.now() - started).toBeLessThan(1400);
	});

	it("会话终止失败不覆盖成功结果", async () => {
		const original = fetchImpl.getMockImplementation();
		if (original === undefined) throw new Error("missing HTTP boundary");
		fetchImpl.mockImplementation(async (url, init) => init.method === "DELETE" ? httpResponse(503, "unavailable") : original(url, init));
		await expect(search()).resolves.toMatchObject({ details: { status: "success", providers: ["exa_mcp"] } });
	});
});
